import { google } from 'googleapis';

const GRAYLABS_SUBJECT = '[GreyLabs AI] PayTM | Motor Insurance Voice AI | Lead Funnel Report';

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getEmailBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
      if (part.parts) { const n = getEmailBody(part); if (n) return n; }
    }
  }
  return '';
}

function extractNumber(label: string, text: string): number {
  const pattern = new RegExp(label + '[^0-9]*([0-9,]+)', 'i');
  const match   = text.match(pattern);
  return match ? parseInt(match[1].replace(/,/g, '')) : 0;
}

function parseFreshFunnel(body: string) {
  const text      = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const freshIdx  = text.indexOf('Fresh Lead Funnel');
  if (freshIdx === -1) { console.log('Fresh Lead Funnel not found'); return null; }
  const retainedIdx = text.indexOf('Retained Lead Funnel', freshIdx);
  const section   = retainedIdx > -1 ? text.slice(freshIdx, retainedIdx) : text.slice(freshIdx, freshIdx + 2000);

  const bot_sent      = extractNumber('Total Leads', section);
  const bot_dialled   = extractNumber('Total Dialed', section);
  const bot_connected = extractNumber('Connected', section);
  const bot_qualified = extractNumber('Qualified', section);
  const high_intent   = extractNumber('High Intent', section);
  const medium_intent = extractNumber('Medium Intent', section);
  const low_intent    = extractNumber('Low Intent', section);

  if (!bot_sent) { console.log('Could not parse numbers from Fresh Lead Funnel section'); return null; }
  return { bot_sent, bot_dialled, bot_connected, bot_qualified, high_intent, medium_intent, low_intent };
}

// Fetch email for a specific date (for backfill) or today
export async function fetchGreylabsData(dateStr: string) {
  const auth  = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Search within a 3-day window around the target date to catch same-day emails
  const target = new Date(dateStr + 'T00:00:00+05:30'); // IST
    const after  = new Date(target); after.setDate(target.getDate() - 1);
    const before = new Date(target); before.setDate(target.getDate() + 1);
    const afterTs  = Math.floor(after.getTime() / 1000);
    const beforeTs = Math.floor(before.getTime() / 1000);

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `from:customreports@greylabs.ai after:${afterTs} before:${beforeTs}`,
      maxResults: 5,
    });
  
  const messages = res.data.messages;
  if (!messages?.length) {
    console.log(`GreyLabs email not found for ${dateStr}`);
    return null;
  }

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messages[0].id!,
    format: 'full',
  });

  const body = getEmailBody(msg.data.payload);
  if (!body) { console.log('Could not extract email body'); return null; }

  const parsed = parseFreshFunnel(body);
  if (!parsed) return null;

  console.log(`GreyLabs parsed for ${dateStr}:`, parsed);
  return parsed;
}
