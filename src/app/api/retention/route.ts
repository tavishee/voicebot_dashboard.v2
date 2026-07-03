import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const maxDuration = 60;

// Retention data schema:
// Redis key: retention:{cohort_date}
// Value: {
//   cohort_date: '2026-06-25',
//   leads_sent: 500,
//   grey: { day0: {connected:125,qualified:30}, day1: {...}, ... day4 }
//   enser: { day0: {converted:5}, day1: {...}, ... day6 }  -- filled by Superset sync
// }

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(request: Request) {
  // GET all retention data
  const redis = getRedis();
  if (!redis) return NextResponse.json({ rows: [] });
  try {
    const keys = await redis.keys('retention:*');
    if (!keys.length) return NextResponse.json({ rows: [] });
    const rows = await Promise.all(keys.map(async k => {
      const raw = await redis.get<string>(k);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }));
    const sorted = rows.filter(Boolean).sort((a:any,b:any) => a.cohort_date.localeCompare(b.cohort_date));
    return NextResponse.json({ rows: sorted });
  } catch(e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Save enser conversion data for a cohort from Superset sync
  try {
    const body = await request.json();
    const { cohort_date, enser } = body;
    if (!cohort_date) return NextResponse.json({ error: 'cohort_date required' }, { status: 400 });

    const redis = getRedis();
    if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 500 });

    const key = `retention:${cohort_date}`;
    const raw = await redis.get<string>(key);
    const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { cohort_date, leads_sent: 0, grey: {}, enser: {} };
    existing.enser = enser;
    await redis.set(key, JSON.stringify(existing));
    return NextResponse.json({ success: true });
  } catch(e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
