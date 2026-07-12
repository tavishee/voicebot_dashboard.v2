
import { NextResponse } from 'next/server';
import { fetchGreylabsData } from '@/lib/gmail';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const maxDuration = 60;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function saveLeadIds(date: string, freshIds: string[], retainedIds: string[]) {
  const cleanFresh = Array.from(new Set(freshIds.map(id => String(id).trim()).filter(Boolean)));
  const cleanRetained = Array.from(new Set(retainedIds.map(id => String(id).trim()).filter(Boolean)));
  const payload = JSON.stringify({
    freshIds: cleanFresh,
    retainedIds: cleanRetained,
    allIds: Array.from(new Set([...cleanFresh, ...cleanRetained])),
  });
  const redis = getRedis();
  if (redis) {
    await redis.set(`lead_ids:${date}`, payload);
    await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
  } else {
    const dir = resolve(process.cwd(), '.data');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `lead_ids_${date}.json`), payload);
  }
  console.log(`Saved lead IDs for ${date}: ${freshIds.length} fresh + ${retainedIds.length} retained`);
}

// Save grey retention cohort data — same logic as cron-trigger
async function saveGreyRetention(reportDate: string, freshRows: any[], retainedRows: any[]) {
  const redis = getRedis();
  if (!redis) return 0;

  const cohortMap: Record<string, Record<string, { connected: number; qualified: number }>> = {};
  const allRows = [...(freshRows||[]), ...(retainedRows||[])];

  for (const r of allRows) {
    const cohort = r.createdDate;
    if (!cohort || cohort < '2026-06-01') continue;
    try {
      const dayN = Math.round((new Date(reportDate+'T00:00:00Z').getTime() - new Date(cohort+'T00:00:00Z').getTime()) / 86400000);
      if (dayN < 0 || dayN > 6) continue;
      if (!cohortMap[cohort]) cohortMap[cohort] = {};
      const key = `day${dayN}`;
      if (!cohortMap[cohort][key]) cohortMap[cohort][key] = { connected: 0, qualified: 0 };
      cohortMap[cohort][key].connected += r.connected > 0 ? 1 : 0;
      cohortMap[cohort][key].qualified += r.qualified === 'YES' ? 1 : 0;
    } catch { continue; }
  }

  let cohortsUpdated = 0;
  for (const [cohort, greyDays] of Object.entries(cohortMap)) {
    const retKey = `retention:${cohort}`;
    const raw = await redis.get<string>(retKey);
    const row: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { cohort_date: cohort, grey: {}, enser: {} };
    if (!row.grey) row.grey = {};
    if (!row.enser) row.enser = {};
    row.grey = { ...row.grey, ...greyDays };
    const fRaw = await redis.get<string>(`funnel:row:v3:${cohort}`);
    if (fRaw) { const fn: any = typeof fRaw === 'string' ? JSON.parse(fRaw) : fRaw; row.leads_sent = fn.fresh_sent||0; }
    await redis.set(retKey, JSON.stringify(row));
    await redis.expire(retKey, 60 * 60 * 24 * 120);
    cohortsUpdated++;
  }
  return cohortsUpdated;
}

export async function GET(request: Request) {
  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  console.log(`Fetching GreyLabs for ${date}`);
  try {
    const parsed = await fetchGreylabsData(date);
    if (!parsed) return NextResponse.json({ success: false, message: 'GreyLabs email not found', date });
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
    if (freshIds.length || retainedIds.length) {
      await saveLeadIds(date, freshIds, retainedIds);
    }
    const cohortsUpdated = await saveGreyRetention(date, freshRows||[], retainedRows||[]);
    return NextResponse.json({ success: true, date, fresh, retained,
      leadIds: { fresh: freshIds.length, retained: retainedIds.length, total: freshIds.length + retainedIds.length },
      cohortsUpdated });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
