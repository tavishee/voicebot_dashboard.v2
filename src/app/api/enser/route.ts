import { NextResponse } from 'next/server';
import { saveEnserOnly } from '@/lib/storage';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, cc_sent, cc_attempted, cc_connected, cc_converted, cc_churn, cc_conversion_on_connect } = body;
    if (!date) return NextResponse.json({ error: 'Date required' }, { status: 400 });
    await saveEnserOnly(date, {
      cc_sent:                  Number(cc_sent)                  || 0,
      cc_attempted:             Number(cc_attempted)             || 0,
      cc_connected:             Number(cc_connected)             || 0,
      cc_converted:             Number(cc_converted)             || 0,
      cc_churn:                 Number(cc_churn)                 || 0,
      cc_conversion_on_connect: Number(cc_conversion_on_connect) / 100 || 0,
    });
    return NextResponse.json({ success: true, date });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
