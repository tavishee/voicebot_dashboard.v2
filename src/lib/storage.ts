import { Redis } from '@upstash/redis';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type FunnelRow = {
  date:                     string;
  // Voicebot (GreyLabs - Fresh Lead Funnel from email body)
  bot_sent:                 number;
  bot_dialled:              number;
  bot_connected:            number;
  bot_qualified:            number;
  high_intent:              number;
  medium_intent:            number;
  low_intent:               number;
  // Gap between bot qualified and CC received
  gap:                      number;
  // Call Centre (Enser - manual upload)
  cc_sent:                  number;
  cc_attempted:             number;
  cc_connected:             number;
  cc_converted:             number;
  cc_churn:                 number;
  cc_conversion_on_connect: number;
  // Computed rates
  bot_connect_rate:         number;
  bot_qualify_rate:         number;
  cc_connect_rate:          number;
  cc_convert_rate:          number;
  e2e_rate:                 number;
};

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const INDEX_KEY  = 'funnel:index:v2';
const ROW_PREFIX = 'funnel:row:v2:';
const LOCAL_FILE = resolve(process.cwd(), '.data', 'funnel-rows.json');

async function getLocalRows(): Promise<Record<string, FunnelRow>> {
  try { return JSON.parse(await readFile(LOCAL_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveLocalRow(row: FunnelRow) {
  const rows = await getLocalRows();
  rows[row.date] = row;
  await mkdir(dirname(LOCAL_FILE), { recursive: true });
  await writeFile(LOCAL_FILE, JSON.stringify(rows, null, 2));
}

function dateScore(d: string) { return parseInt(d.replace(/-/g, ''), 10); }

export function getEmptyRow(date: string): FunnelRow {
  return {
    date, bot_sent:0, bot_dialled:0, bot_connected:0, bot_qualified:0,
    high_intent:0, medium_intent:0, low_intent:0, gap:0,
    cc_sent:0, cc_attempted:0, cc_connected:0, cc_converted:0,
    cc_churn:0, cc_conversion_on_connect:0,
    bot_connect_rate:0, bot_qualify_rate:0, cc_connect_rate:0,
    cc_convert_rate:0, e2e_rate:0,
  };
}

function computeRates(r: FunnelRow): FunnelRow {
  r.bot_connect_rate         = r.bot_dialled   > 0 ? r.bot_connected / r.bot_dialled   : 0;
  r.bot_qualify_rate         = r.bot_connected > 0 ? r.bot_qualified / r.bot_connected : 0;
  r.cc_connect_rate          = r.cc_attempted  > 0 ? r.cc_connected  / r.cc_attempted  : 0;
  r.cc_convert_rate          = r.cc_connected  > 0 ? r.cc_converted  / r.cc_connected  : 0;
  r.e2e_rate                 = r.bot_sent      > 0 ? r.cc_converted  / r.bot_sent      : 0;
  r.gap                      = r.bot_qualified - r.cc_sent;
  return r;
}

export async function saveRow(row: FunnelRow) {
  const redis = getRedis();
  const computed = computeRates({ ...row });
  if (!redis && process.env.VERCEL) throw new Error('Hosted storage is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.');
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
