import { NextResponse } from 'next/server';
import { google } from 'googleapis';

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
      if (part.parts) { const n = getBody(part); if (n) return n; }
    }
  }
  return '';
}

export async function GET() {
  try {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: client });

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:greylabs.ai newer_than:5d',
      maxResults: 1,
    });

    const messages = res.data.messages || [];
    if (!messages.length) return NextResponse.json({ error: 'No messages found' });

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messages[0].id!,
      format: 'full',
    });

    const body = getBody(msg.data.payload);
    const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const freshIdx = text.indexOf('Fresh Lead Funnel');

    return NextResponse.json({
      bodyLength: body.length,
      freshFound: freshIdx > -1,
      freshSection: freshIdx > -1 ? text.slice(freshIdx, freshIdx + 500) : 'NOT FOUND',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message });
  }
}
