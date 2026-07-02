import { NextResponse } from 'next/server';
import { fetchGreylabsData } from '@/lib/gmail';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const maxDuration = 60;

async function saveLeadIds(date: string, freshIds: string[], retainedIds: string[]) {
  const payload = JSON.stringify({ freshIds, retainedIds, allIds: [...freshIds, ...retainedIds] });
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const redis = new Redis({ url, token });
    await redis.set(`lead_ids:${date}`, payload);
    await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
  } else {
    const dir = resolve(process.cwd(), '.data');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `lead_ids_${date}.json`), payload);
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  console.log(`Cron running for ${date}`);
  try {
    const parsed = await fetchGreylabsData(date);
    if (!parsed) {
      return NextResponse.json({ success: false, message: 'GreyLabs email not found', date });
    }
    const { fresh, retained, freshIds, retainedIds } = parsed;
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
    return NextResponse.json({ success: true, date, fresh, retained });
  } catch (err: any) {
    console.error('Cron error:', err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
