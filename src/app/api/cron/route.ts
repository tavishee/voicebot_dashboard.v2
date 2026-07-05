import { NextResponse } from 'next/server';
import { fetchGreylabsData } from '@/lib/gmail';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { checkSupersetAuth, runSupersetQuery } from '@/lib/superset-mcp';
import { ccMetricsQuery } from '@/lib/superset-queries';

export const maxDuration = 60;

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function saveLeadIds(redis: Redis, date: string, freshIds: string[], retainedIds: string[]) {
  const payload = JSON.stringify({
    freshIds,
    retainedIds,
    allIds: Array.from(new Set([...freshIds, ...retainedIds]))
  });
  await redis.set(`lead_ids:${date}`, payload);
  await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
}

async function saveRetentionGrey(
  redis: Redis,
  reportDate: string,
  rows: { leadId: string; createdDate: string; connected: number; qualified: string }[]
) {
  // Group by cohort date (Created date) and compute day_n = reportDate - createdDate
  const cohortMap: Record<string, Record<string, { connected: number; qualified: number }>> = {};

  for (const r of rows) {
    const cohort = r.createdDate;
    if (!cohort || cohort < '2026-06-01') continue; // skip very old cohorts
    try {
      const rDate = new Date(`${reportDate}T00:00:00Z`);
      const cDate = new Date(`${cohort}T00:00:00Z`);
      const dayN  = Math.round((rDate.getTime() - cDate.getTime()) / 86400000);
      if (dayN < 0 || dayN > 4) continue;
      const key = `day${dayN}`;
      if (!cohortMap[cohort]) cohortMap[cohort] = {};
      if (!cohortMap[cohort][key]) cohortMap[cohort][key] = { connected: 0, qualified: 0 };
      cohortMap[cohort][key].connected += r.connected > 0 ? 1 : 0;
      cohortMap[cohort][key].qualified += r.qualified === 'YES' ? 1 : 0;
    } catch { continue; }
  }

  // Merge into Redis retention rows
  for (const [cohortDate, greyDays] of Object.entries(cohortMap)) {
    const retKey = `retention:${cohortDate}`;
    const raw    = await redis.get<string>(retKey);
    const row: any = raw
      ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
      : { cohort_date: cohortDate, grey: {}, enser: {} };

    row.cohort_date = cohortDate;
    if (!row.grey)  row.grey  = {};
    if (!row.enser) row.enser = {};

    // Merge day data (don't overwrite existing days with zeros)
    for (const [day, counts] of Object.entries(greyDays)) {
      row.grey[day] = counts;
    }

    // Set leads_sent from funnel row if available
    const funnelRaw = await redis.get<string>(`funnel:row:v3:${cohortDate}`);
    if (funnelRaw) {
      const fn: any = typeof funnelRaw === 'string' ? JSON.parse(funnelRaw) : funnelRaw;
      row.leads_sent = fn.fresh_sent || 0;
    }

    await redis.set(retKey, JSON.stringify(row));
    await redis.expire(retKey, 60 * 60 * 24 * 120);
  }

  return Object.keys(cohortMap).length;
}

async function syncEnserCC(redis: Redis, date: string) {
  try {
    const auth = await checkSupersetAuth();
    if (!auth.authenticated) return { skipped: 'Superset auth required' };

    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);

    const rows = await runSupersetQuery(ccMetricsQuery(date, nextDate));
    const ccSent      = Number(rows[0]?.cc_sent)      || 0;
    const ccAttempted = Number(rows[0]?.cc_attempted) || 0;
    const ccConnected = Number(rows[0]?.cc_connected) || 0;

    // Save to funnel row (preserves cc_converted if already set)
    const funnelKey = `funnel:row:v3:${date}`;
    const existing  = await redis.get<string>(funnelKey);
    const funnel: any = existing
      ? (typeof existing === 'string' ? JSON.parse(existing) : existing)
      : { date };
    funnel.cc_sent      = ccSent;
    funnel.cc_attempted = ccAttempted;
    funnel.cc_connected = ccConnected;
    await redis.set(funnelKey, JSON.stringify(funnel));

    return { cc_sent: ccSent, cc_attempted: ccAttempted, cc_connected: ccConnected };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const secretParam = new URL(request.url).searchParams.get('secret');
  // Allow either Bearer token (Vercel cron) or secret param (manual dashboard trigger)
  const validAuth = authHeader === `Bearer ${process.env.CRON_SECRET}`
    || secretParam === process.env.CRON_SECRET;
  if (!validAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  console.log(`Cron running for ${date}`);

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 500 });

  const result: Record<string, any> = { date };

  try {
    // 1. Fetch GreyLabs Gmail data
    const parsed = await fetchGreylabsData(date);
    if (!parsed) {
      result.gmail = { success: false, message: 'GreyLabs email not found — will retry next run' };
    } else {
      const { fresh, retained, freshIds, retainedIds, freshRows, retainedRows } = parsed;

      // Save funnel summary
      await saveGreylabsOnly(date, {
        fresh_sent: fresh.sent, fresh_dialled: fresh.dialled, fresh_connected: fresh.connected,
        fresh_qualified: fresh.qualified, fresh_high: fresh.high, fresh_medium: fresh.medium,
        fresh_low: fresh.low, fresh_callback: fresh.callback,
        ...(retained ? {
          ret_sent: retained.sent, ret_dialled: retained.dialled, ret_connected: retained.connected,
          ret_qualified: retained.qualified, ret_high: retained.high, ret_medium: retained.medium,
          ret_low: retained.low, ret_callback: retained.callback,
        } : {}),
      });

      // Save lead IDs
      if (freshIds.length || retainedIds.length) {
        await saveLeadIds(redis, date, freshIds, retainedIds);
      }

      // Save grey retention from row-level data
      const allRows = [
        ...(freshRows || []),
        ...(retainedRows || []),
      ];
      const cohortsUpdated = allRows.length > 0
        ? await saveRetentionGrey(redis, date, allRows)
        : 0;

      result.gmail = {
        success: true,
        fresh_sent: fresh.sent, fresh_qualified: fresh.qualified,
        ret_sent: retained?.sent || 0, ret_qualified: retained?.qualified || 0,
        fresh_ids: freshIds.length, ret_ids: retainedIds.length,
        cohorts_updated: cohortsUpdated,
      };
    }

    // 2. Auto-sync Enser cc_sent for today
    result.enser = await syncEnserCC(redis, date);

  } catch (err: any) {
    console.error('Cron error:', err.message);
    result.error = err.message;
  }

  return NextResponse.json(result);
}
