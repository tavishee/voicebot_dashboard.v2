import { NextResponse } from 'next/server';
import { fetchGreylabsData } from '@/lib/gmail';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { checkSupersetAuth, runSupersetQuery } from '@/lib/superset-mcp';
import { ccMetricsQuery } from '@/lib/superset-queries';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(request: Request) {
  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const result: Record<string, any> = { date };

  try {
    const redis = getRedis();
    if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 500 });

    // 1. Gmail fetch
    let parsed: any = null;
    try { parsed = await fetchGreylabsData(date); } catch (e: any) { result.gmail = { success: false, message: e.message }; }

    if (!parsed) {
      if (!result.gmail) result.gmail = { success: false, message: 'Email not found for this date' };
    } else {
      const { fresh, retained, freshIds, retainedIds, freshRows, retainedRows } = parsed;

      // Save funnel summary
      await saveGreylabsOnly(date, {
        fresh_sent: fresh?.sent||0, fresh_dialled: fresh?.dialled||0,
        fresh_connected: fresh?.connected||0, fresh_qualified: fresh?.qualified||0,
        fresh_high: fresh?.high||0, fresh_medium: fresh?.medium||0,
        fresh_low: fresh?.low||0, fresh_callback: fresh?.callback||0,
        ...(retained ? {
          ret_sent: retained.sent||0, ret_dialled: retained.dialled||0,
          ret_connected: retained.connected||0, ret_qualified: retained.qualified||0,
          ret_high: retained.high||0, ret_medium: retained.medium||0,
          ret_low: retained.low||0, ret_callback: retained.callback||0,
        } : {}),
      });

      // Save lead IDs
      const fIds = freshIds || [];
      const rIds = retainedIds || [];
      if (fIds.length || rIds.length) {
        await redis.set(`lead_ids:${date}`, JSON.stringify({
          freshIds: fIds, retainedIds: rIds,
          allIds: Array.from(new Set([...fIds, ...rIds]))
        }));
        await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
      }

      // Build cohort map in memory first, then do one redis get+set per cohort
      const cohortMap: Record<string, Record<string, { connected: number; qualified: number }>> = {};
      const allRows = [...(freshRows||[]), ...(retainedRows||[])];

      for (const r of allRows) {
        const cohort = r.createdDate;
        if (!cohort || cohort < '2026-06-01') continue;
        try {
          const dayN = Math.round((new Date(date+'T00:00:00Z').getTime() - new Date(cohort+'T00:00:00Z').getTime()) / 86400000);
          if (dayN < 0 || dayN > 4) continue;
          if (!cohortMap[cohort]) cohortMap[cohort] = {};
          const key = `day${dayN}`;
          if (!cohortMap[cohort][key]) cohortMap[cohort][key] = { connected: 0, qualified: 0 };
          cohortMap[cohort][key].connected += r.connected > 0 ? 1 : 0;
          cohortMap[cohort][key].qualified += r.qualified === 'YES' ? 1 : 0;
        } catch { continue; }
      }

      // One redis get+set per cohort (not per row)
      let cohortsUpdated = 0;
      for (const [cohort, greyDays] of Object.entries(cohortMap)) {
        const retKey = `retention:${cohort}`;
        const raw = await redis.get<string>(retKey);
        const row: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { cohort_date: cohort, grey: {}, enser: {} };
        if (!row.grey)  row.grey  = {};
        if (!row.enser) row.enser = {};
        for (const [day, counts] of Object.entries(greyDays)) { row.grey[day] = counts; }
        const fRaw = await redis.get<string>(`funnel:row:v3:${cohort}`);
        if (fRaw) { const fn: any = typeof fRaw === 'string' ? JSON.parse(fRaw) : fRaw; row.leads_sent = fn.fresh_sent||0; }
        await redis.set(retKey, JSON.stringify(row));
        await redis.expire(retKey, 60 * 60 * 24 * 120);
        cohortsUpdated++;
      }

      result.gmail = {
        success: true,
        fresh_sent: fresh?.sent||0, fresh_qualified: fresh?.qualified||0,
        ret_sent: retained?.sent||0, ret_qualified: retained?.qualified||0,
        lead_ids: fIds.length + rIds.length, cohorts_updated: cohortsUpdated,
      };
    }

    // 2. Enser cc_sent
    try {
      const auth = await checkSupersetAuth();
      if (!auth.authenticated) {
        result.enser = { skipped: 'Superset auth required' };
      } else {
        const next = new Date(date+'T00:00:00Z'); next.setUTCDate(next.getUTCDate()+1);
        const nextDate = next.toISOString().slice(0,10);
        const rows = await runSupersetQuery(ccMetricsQuery(date, nextDate));
        const cc = { cc_sent: Number(rows[0]?.cc_sent)||0, cc_attempted: Number(rows[0]?.cc_attempted)||0, cc_connected: Number(rows[0]?.cc_connected)||0 };
        const fKey = `funnel:row:v3:${date}`;
        const ex  = await redis.get<string>(fKey);
        const fn: any = ex ? (typeof ex === 'string' ? JSON.parse(ex) : ex) : { date };
        await redis.set(fKey, JSON.stringify({ ...fn, ...cc }));
        result.enser = cc;
      }
    } catch (e: any) { result.enser = { error: e.message }; }

  } catch (e: any) {
    result.error = e.message;
  }

  return NextResponse.json(result);
}
