import { NextResponse } from 'next/server';
import { getAllRows } from '@/lib/storage';

export async function GET() {
  try {
    const rows = await getAllRows();
    return NextResponse.json({ rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
