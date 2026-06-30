import { NextResponse } from 'next/server';
import { fetchEnserRowsFromSuperset } from '@/lib/superset';
import { saveEnserOnly } from '@/lib/storage';

export async function GET(request: Request) {
  try {
    const cookieHeader = request.headers.get('x-superset-cookie') || '';
    if (!cookieHeader) {
      return NextResponse.json({ error: 'SUPERSET_AUTH_REQUIRED' }, { status: 401 });
    }

    const rows = await fetchEnserRowsFromSuperset(cookieHeader);

    // Save each day's row into Redis
    for (const r of rows as any[]) {
      await saveEnserOnly(r.date, {
        cc_sent:                  r.cc_sent,
        cc_attempted:             r.cc_attempted,
        cc_connected:             r.cc_connected,
        cc_converted:             r.cc_converted,
        cc_churn:                 r.cc_churn,
        cc_conversion_on_connect: r.cc_conversion_on_connect,
      });
    }

    return NextResponse.json({ success: true, count: rows.length, rows });
  } catch (err: any) {
    if (err.message === 'SUPERSET_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'SUPERSET_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
