import { NextResponse } from 'next/server';
import { checkSupersetAuth, runSupersetQuery } from '@/lib/superset-mcp';
import { combinedQuery } from '@/lib/superset-queries';
import { saveEnserOnly } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { date } = await request.json();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return NextResponse.json({ error: 'A valid sync date is required' }, { status: 400 });
    }

    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);

    const auth = await checkSupersetAuth();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'SUPERSET_AUTH_REQUIRED', authUrl: auth.authUrl }, { status: 401 });
    }

    const rows = await runSupersetQuery(combinedQuery(date, nextDate));
    const ccSent = Number(rows[0]?.cc_sent) || 0;
    const ccAttempted = Number(rows[0]?.cc_attempted) || 0;
    const ccConnected = Number(rows[0]?.cc_connected) || 0;
    const ccConverted = Number(rows[0]?.cc_converted) || 0;

    await saveEnserOnly(date, {
      cc_sent: ccSent,
      cc_attempted: ccAttempted,
      cc_connected: ccConnected,
      cc_converted: ccConverted,
      cc_churn: 0,
      cc_conversion_on_connect: ccConnected > 0 ? ccConverted / ccConnected : 0,
    });

    return NextResponse.json({
      success: true,
      date,
      counts: { cc_sent: ccSent, cc_attempted: ccAttempted, cc_connected: ccConnected, cc_converted: ccConverted },
      sourceRows: { combined: rows.length },
    });
  } catch (error: unknown) {
    const typed = error as Error & { authUrl?: string };
    if (typed?.message === 'SUPERSET_AUTH_REQUIRED') {
      return NextResponse.json({ error: typed.message, authUrl: typed.authUrl }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : 'Superset sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
