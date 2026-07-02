import { Redis } from '@upstash/redis';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type FunnelRow = {
  date: string;
  fresh_sent: number; fresh_dialled: number; fresh_connected: number; fresh_qualified: number;
  fresh_high: number; fresh_medium: number; fresh_low: number; fresh_callback: number;
  fresh_connect_rate: number; fresh_qualify_rate: number;
  ret_sent: number; ret_dialled: number; ret_connected: number; ret_qualified: number;
  ret_high: number; ret_medium: number; ret_low: number; ret_callback: number;
  ret_connect_rate: number; ret_qualify_rate: number;
  bot_sent: number; bot_qualified: number; bot_dialled: number; bot_connected: number;
  high_intent: number; medium_intent: number; low_intent: number;
  bot_connect_rate: number; bot_qualify_rate: number;
  gap: number;
  cc_sent: number; cc_attempted: number; cc_connected: number; cc_converted: number;
  cc_churn: number; cc_conversion_on_connect: number;
  cc_connect_rate: number; cc_convert_rate: number; e2e_rate: number;
};

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const INDEX_KEY  = 'funnel:index:v3';
const ROW_PREFIX = 'funnel:row:v3:';
const LOCAL_FILE = resolve(process.cwd(), '.data', 'funnel-rows-v3.json');

async function getLocalRows(): Promise<Record<string, FunnelRow>> {
  try { return JSON.parse(await readFile(LOCAL_FILE, 'utf8')); } catch { return {}; }
}
async function saveLocalRow(row: FunnelRow) {
  const rows = await getLocalRows(); rows[row.date] = row;
  await mkdir(dirname(LOCAL_FILE), { recursive: true });
  await writeFile(LOCAL_FILE, JSON.stringify(rows, null, 2));
}

function dateScore(d: string) { return parseInt(d.replace(/-/g, ''), 10); }

export function getEmptyRow(date: string): FunnelRow {
  return {
    date,
    fresh_sent:0, fresh_dialled:0, fresh_connected:0, fresh_qualified:0,
    fresh_high:0, fresh_medium:0, fresh_low:0, fresh_callback:0,
    fresh_connect_rate:0, fresh_qualify_rate:0,
    ret_sent:0, ret_dialled:0, ret_connected:0, ret_qualified:0,
    ret_high:0, ret_medium:0, ret_low:0, ret_callback:0,
    ret_connect_rate:0, ret_qualify_rate:0,
    bot_sent:0, bot_qualified:0, bot_dialled:0, bot_connected:0,
    high_intent:0, medium_intent:0, low_intent:0,
    bot_connect_rate:0, bot_qualify_rate:0, gap:0,
    cc_sent:0, cc_attempted:0, cc_connected:0, cc_converted:0,
    cc_churn:0, cc_conversion_on_connect:0,
    cc_connect_rate:0, cc_convert_rate:0, e2e_rate:0,
  };
}

function computeRates(r: FunnelRow): FunnelRow {
  r.fresh_connect_rate = r.fresh_dialled   > 0 ? r.fresh_connected / r.fresh_dialled   : 0;
  r.fresh_qualify_rate = r.fresh_connected > 0 ? r.fresh_qualified / r.fresh_connected : 0;
  r.ret_connect_rate   = r.ret_dialled     > 0 ? r.ret_connected   / r.ret_dialled     : 0;
  r.ret_qualify_rate   = r.ret_connected   > 0 ? r.ret_qualified   / r.ret_connected   : 0;
  r.bot_sent           = r.fresh_sent + r.ret_sent;
  r.bot_qualified      = r.fresh_qualified + r.ret_qualified;
  r.bot_dialled        = r.fresh_dialled + r.ret_dialled;
  r.bot_connected      = r.fresh_connected + r.ret_connected;
  r.high_intent        = r.fresh_high + r.ret_high;
  r.medium_intent      = r.fresh_medium + r.ret_medium;
  r.low_intent         = r.fresh_low + r.ret_low;
  r.bot_connect_rate   = r.bot_dialled   > 0 ? r.bot_connected / r.bot_dialled   : 0;
  r.bot_qualify_rate   = r.bot_connected > 0 ? r.bot_qualified / r.bot_connected : 0;
  r.gap                = r.bot_qualified - r.cc_sent;
  r.cc_connect_rate    = r.cc_attempted  > 0 ? r.cc_connected  / r.cc_attempted  : 0;
  r.cc_convert_rate    = r.cc_connected  > 0 ? r.cc_converted  / r.cc_connected  : 0;
  r.e2e_rate           = r.bot_sent      > 0 ? r.cc_converted  / r.bot_sent      : 0;
  r.cc_conversion_on_connect = r.cc_connect_rate > 0 ? r.cc_converted / r.cc_connected : 0;
  return r;
}

export async function saveRow(row: FunnelRow) {
  const redis = getRedis();
  const computed = computeRates({ ...row });
  if (!redis && process.env.VERCEL) throw new Error('Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.');
  if (!redis) { await saveLocalRow(computed); return; }
  await redis.set(ROW_PREFIX + row.date, JSON.stringify(computed));
  await redis.zadd(INDEX_KEY, { score: dateScore(row.date), member: row.date });
}

export async function getRow(date: string): Promise<FunnelRow | null> {
  const redis = getRedis();
  if (!redis) return (await getLocalRows())[date] || null;
  try {
    const raw = await redis.get<string>(ROW_PREFIX + date);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw as FunnelRow;
  } catch { return null; }
}

export async function saveGreylabsOnly(date: string, data: Partial<FunnelRow>) {
  const existing = await getRow(date);
  const merged   = { ...(existing || getEmptyRow(date)), ...data, date };
  await saveRow(merged as FunnelRow);
}

export async function saveEnserOnly(date: string, data: Partial<FunnelRow>) {
  const existing = await getRow(date);
  const merged   = { ...(existing || getEmptyRow(date)), ...data, date };
  await saveRow(merged as FunnelRow);
}

export async function getAllRows(): Promise<FunnelRow[]> {
  const redis = getRedis();
  if (!redis) return Object.values(await getLocalRows()).sort((a, b) => a.date.localeCompare(b.date));
  const dates = await redis.zrange(INDEX_KEY, 0, -1) as string[];
  if (!dates.length) return [];
  const rows = await Promise.all(dates.map(async d => {
    const raw = await redis.get<string>(ROW_PREFIX + d);
    if (!raw) return null;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as FunnelRow;
  }));
  return rows.filter(Boolean) as FunnelRow[];
}
