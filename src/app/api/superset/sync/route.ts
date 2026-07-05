import { NextResponse } from 'next/server';
import { checkSupersetAuth, runSupersetQuery } from '@/lib/superset-mcp';
import { ccMetricsQuery, combinedQuery } from '@/lib/superset-queries';
import { saveEnserOnly } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { date, skipAttribution } = await request.json();
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

    // Step 1: Fast query — cc_sent, cc_attempted, cc_connected (no joins, no window functions)
    const fastRows = await runSupersetQuery(ccMetricsQuery(date, nextDate));
    const ccSent      = Number(fastRows[0]?.cc_sent) || 0;
    const ccAttempted = Number(fastRows[0]?.cc_attempted) || 0;
    const ccConnected = Number(fastRows[0]?.cc_connected) || 0;

    // Save immediately so cc_sent shows even if attribution times out
    await saveEnserOnly(date, {
      cc_sent: ccSent,
      cc_attempted: ccAttempted,
      cc_connected: ccConnected,
      cc_converted: 0,
      cc_churn: 0,
      cc_conversion_on_connect: 0,
    });

    // Step 2: Full attribution query for cc_converted (can time out on StarRocks)
    let ccConverted = 0;
    let attributionError = null;
    if (!skipAttribution) {
      try {
        const fullRows = await runSupersetQuery(combinedQuery(date, nextDate));
        ccConverted = Number(fullRows[0]?.cc_converted) || 0;
        await saveEnserOnly(date, {
          cc_sent: ccSent,
          cc_attempted: ccAttempted,
          cc_connected: ccConnected,
          cc_converted: ccConverted,
          cc_churn: 0,
          cc_conversion_on_connect: ccConnected > 0 ? ccConverted / ccConnected : 0,
        });
      } catch (err) {
        attributionError = err instanceof Error ? err.message : 'Attribution query timed out';
      }
    }

    return NextResponse.json({
      success: true,
      date,
      counts: { cc_sent: ccSent, cc_attempted: ccAttempted, cc_connected: ccConnected, cc_converted: ccConverted },
      ...(attributionError ? { warning: `cc_sent/connected saved. Attribution failed: ${attributionError}` } : {}),
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
