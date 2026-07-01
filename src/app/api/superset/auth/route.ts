import { NextResponse } from 'next/server';
import { checkSupersetAuth } from '@/lib/superset-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const auth = await checkSupersetAuth();
    return NextResponse.json({ authenticated: auth.authenticated });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not check Superset authentication' },
      { status: 500 },
    );
  }
}
