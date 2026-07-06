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

// Shared logic with /api/cron — runs Gmail fetch + grey retention + Enser cc_sent for any date
// No auth required — triggered from dashboard UI (same-origin)
export async function GET(request: Request) {
  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 500 });

  const result: Record<string, any> = { date };

  try {
    // 1. Gmail fetch
    const parsed = await fetchGreylabsData(date);
    if (!parsed) {
      result.gmail = { success: false, message: 'GreyLabs email not found for this date' };
    } else {
      const { fresh, retained, freshIds, retainedIds, freshRows, retainedRows } = parsed as any;

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
      if ((freshIds?.length || 0) + (retainedIds?.length || 0) > 0) {
        const payload = JSON.stringify({
          freshIds: freshIds || [],
          retainedIds: retainedIds || [],
          allIds: Array.from(new Set([...(freshIds||[]), ...(retainedIds||[])]))
        });
        await redis.set(`lead_ids:${date}`, payload);
        await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
      }

      // Save grey retention from row-level data
      const allRows = [...(freshRows||[]), ...(retainedRows||[])];
      let cohortsUpdated = 0;
      for (const r of allRows) {
        const cohort = r.createdDate;
        if (!cohort || cohort < '2026-06-01') continue;
        try {
          const rDate = new Date(date + 'T00:00:00Z');
          const cDate = new Date(cohort + 'T00:00:00Z');
          const dayN  = Math.round((rDate.getTime() - cDate.getTime()) / 86400000);
          if (dayN < 0 || dayN > 4) continue;
          const retKey = `retention:${cohort}`;
          const raw = await redis.get<string>(retKey);
          const row: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { cohort_date: cohort, grey: {}, enser: {} };
          if (!row.grey) row.grey = {};
          if (!row.enser) row.enser = {};
          const key = `day${dayN}`;
          if (!row.grey[key]) row.grey[key] = { connected: 0, qualified: 0 };
          row.grey[key].connected += r.connected > 0 ? 1 : 0;
          row.grey[key].qualified += r.qualified === 'YES' ? 1 : 0;
          const funnelRaw = await redis.get<string>(`funnel:row:v3:${cohort}`);
          if (funnelRaw) {
            const fn: any = typeof funnelRaw === 'string' ? JSON.parse(funnelRaw) : funnelRaw;
            row.leads_sent = fn.fresh_sent || 0;
          }
          await redis.set(retKey, JSON.stringify(row));
          await redis.expire(retKey, 60 * 60 * 24 * 120);
          cohortsUpdated++;
        } catch { continue; }
      }

      result.gmail = {
        success: true,
        fresh_sent: fresh.sent, fresh_qualified: fresh.qualified,
        ret_sent: retained?.sent || 0, ret_qualified: retained?.qualified || 0,
        fresh_ids: freshIds?.length || 0, ret_ids: retainedIds?.length || 0,
        cohorts_updated: cohortsUpdated,
      };
    }

    // 2. Enser cc_sent fast query
    try {
      const auth = await checkSupersetAuth();
      if (!auth.authenticated) {
        result.enser = { skipped: 'Superset auth required — open dashboard on Paytm WiFi first' };
      } else {
        const next = new Date(date + 'T00:00:00Z');
        next.setUTCDate(next.getUTCDate() + 1);
        const nextDate = next.toISOString().slice(0, 10);
        const rows = await runSupersetQuery(ccMetricsQuery(date, nextDate));
        const ccSent      = Number(rows[0]?.cc_sent)      || 0;
        const ccAttempted = Number(rows[0]?.cc_attempted) || 0;
        const ccConnected = Number(rows[0]?.cc_connected) || 0;
        const funnelKey   = `funnel:row:v3:${date}`;
        const existing    = await redis.get<string>(funnelKey);
        const funnel: any = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : { date };
        funnel.cc_sent = ccSent; funnel.cc_attempted = ccAttempted; funnel.cc_connected = ccConnected;
        await redis.set(funnelKey, JSON.stringify(funnel));
        result.enser = { cc_sent: ccSent, cc_attempted: ccAttempted, cc_connected: ccConnected };
      }
    } catch (err: any) {
      result.enser = { error: err.message };
    }

  } catch (err: any) {
    result.error = err.message;
  }

  return NextResponse.json(result);
}
