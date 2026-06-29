import { NextResponse } from 'next/server';
import { fetchGreylabsData } from '@/lib/gmail';
import { saveGreylabsOnly } from '@/lib/storage';

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Support ?date=YYYY-MM-DD for backfill, otherwise use today
  const url    = new URL(request.url);
  const date   = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  console.log(`Cron running for ${date}`);

  try {
    const data = await fetchGreylabsData(date);
    if (!data) {
      return NextResponse.json({ success: false, message: 'GreyLabs email not found', date });
    }
    await saveGreylabsOnly(date, data);
    return NextResponse.json({ success: true, date, data });
  } catch (err: any) {
    console.error('Cron error:', err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
