import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function GET(request: Request) {
  const url  = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    const redis = new Redis({ url: redisUrl, token: redisToken });
    try {
      const raw = await redis.get<string>(`lead_ids:${date}`);
      if (raw) return NextResponse.json(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch { /* fall through */ }
  } else {
    try {
      const raw = await readFile(resolve(process.cwd(), '.data', `lead_ids_${date}.json`), 'utf8');
      return NextResponse.json(JSON.parse(raw));
    } catch { /* fall through */ }
  }

  return NextResponse.json({ freshIds: [], retainedIds: [], allIds: [] });
}
