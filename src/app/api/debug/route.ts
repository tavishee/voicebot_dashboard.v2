import { NextResponse } from 'next/server';
import { google } from 'googleapis';

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
      q: 'subject:"GreyLabs" newer_than:5d',
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    const details = await Promise.all(messages.slice(0,3).map(async m => {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
      return msg.data.payload?.headers;
    }));

    return NextResponse.json({ count: messages.length, details });
  } catch (err: any) {
    return NextResponse.json({ error: err.message });
  }
}
