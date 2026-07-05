import { NextResponse } from 'next/server';

// Internal trigger — calls /api/cron server-side with the CRON_SECRET
// No auth required since it's triggered from the dashboard UI (same origin)
export async function GET(request: Request) {
  const url  = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const secret = process.env.CRON_SECRET || '';
  const base   = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const res = await fetch(`${base}/api/cron?date=${date}`, {
    headers: { authorization: `Bearer ${secret}` },
  });

  const data = await res.json();
  return NextResponse.json(data);
}
