import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const maxDuration = 60;

// Restore Jun 25 funnel data — was overwritten by a Gmail fetch bug that
// silently grabbed Jun 26's email data. Jun 25 has no standalone daily email;
// original correct numbers came from the multi-sheet backfill Excel.
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('secret') !== 'vb-secret-2026') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const results: Record<string, string> = {};
  const date = '2026-06-25';

  // Correct values from the original Lead_Funnel_Daily_23Jun_30Jun_2026.xlsx upload
  const correct = {
    date,
    fresh_sent: 5979, fresh_dialled: 5979, fresh_connected: 1221, fresh_qualified: 294,
    fresh_high: 204, fresh_medium: 23, fresh_low: 130, fresh_callback: 67,
    ret_sent: 21851, ret_dialled: 21851, ret_connected: 1418, ret_qualified: 244,
    ret_high: 121, ret_medium: 20, ret_low: 162, ret_callback: 103,
  };

  const key = `funnel:row:v3:${date}`;
  const raw = await redis.get<string>(key);
  const existing: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  const cc = { cc_sent: existing.cc_sent||0, cc_attempted: existing.cc_attempted||0, cc_connected: existing.cc_connected||0, cc_converted: existing.cc_converted||0 };
  const row: any = { ...existing, ...correct, ...cc };
  row.bot_sent = row.fresh_sent + row.ret_sent;
  row.bot_qualified = row.fresh_qualified + row.ret_qualified;
  row.bot_connected = row.fresh_connected + row.ret_connected;
  row.bot_dialled = row.fresh_dialled + row.ret_dialled;
  row.high_intent = row.fresh_high + row.ret_high;
  row.medium_intent = row.fresh_medium + row.ret_medium;
  row.low_intent = row.fresh_low + row.ret_low;
  row.callback_agent = row.fresh_callback + row.ret_callback;
  await redis.set(key, JSON.stringify(row));
  results['restored'] = `Jun 25: fresh=${row.fresh_sent} fq=${row.fresh_qualified} ret=${row.ret_sent} rq=${row.ret_qualified}`;

  return NextResponse.json({ success: true, results });
}
