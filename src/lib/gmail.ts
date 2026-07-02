import { google } from 'googleapis';
import * as XLSX from 'xlsx';

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

function findXlsxAttachment(parts: any[]): { attachmentId: string } | null {
  for (const part of parts) {
    const name = (part.filename || '').toLowerCase();
    if ((name.endsWith('.xlsx') || name.endsWith('.xls')) && part.body?.attachmentId) {
      return { attachmentId: part.body.attachmentId };
    }
    if (part.parts) {
      const found = findXlsxAttachment(part.parts);
      if (found) return found;
    }
  }
  return null;
}

function extractNumber(label: string, text: string): number {
  const pattern = new RegExp(label + '[^0-9]*([0-9,]+)', 'i');
  const match = text.match(pattern);
  return match ? parseInt(match[1].replace(/,/g, '')) : 0;
}

function parseFunnelSection(section: string) {
  return {
    sent:      extractNumber('Total Leads', section),
    dialled:   extractNumber('Total Dialed', section),
    connected: extractNumber('Connected', section),
    qualified: extractNumber('Qualified', section),
    high:      extractNumber('High Intent', section),
    medium:    extractNumber('Medium Intent', section),
    low:       extractNumber('Low Intent', section),
    callback:  extractNumber('Callback', section),
  };
}

function parseEmailBody(body: string) {
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const freshIdx    = text.indexOf('Fresh Lead Funnel');
  const retainedIdx = text.indexOf('Retained Lead Funnel');
  if (freshIdx === -1) { console.log('Fresh Lead Funnel not found'); return null; }
  const freshSection    = retainedIdx > -1 ? text.slice(freshIdx, retainedIdx) : text.slice(freshIdx, freshIdx + 2000);
  const retainedSection = retainedIdx > -1 ? text.slice(retainedIdx, retainedIdx + 2000) : null;
  const fresh    = parseFunnelSection(freshSection);
  const retained = retainedSection ? parseFunnelSection(retainedSection) : null;
  if (!fresh.sent) { console.log('Could not parse Fresh Lead Funnel numbers'); return null; }
  return { fresh, retained };
}

async function extractLeadIds(gmail: any, messageId: string, attachmentId: string) {
  const att = await gmail.users.messages.attachments.get({
    userId: 'me', messageId, id: attachmentId,
  });
  const buffer = Buffer.from(att.data.data, 'base64');
  const wb = XLSX.read(buffer, { type: 'buffer' });

  function getIdsFromSheet(sheetName: string): string[] {
    const found = wb.SheetNames.find(n => n.toLowerCase().includes(sheetName.toLowerCase()));
    if (!found) {
      console.log(`Sheet not found matching "${sheetName}". Available: ${wb.SheetNames.join(', ')}`);
      return [];
    }
    const ws = wb.Sheets[found];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return [];

    // Search first 10 rows for "Lead ID" header (it's in row 5, not row 1)
    let headerRowIdx = -1;
    let col = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const headers = rows[i].map((h: any) => String(h || '').trim().toLowerCase());
      const found2 = headers.findIndex(h => h === 'lead id' || h === 'lead_id' || h === 'leadid');
      if (found2 !== -1) { headerRowIdx = i; col = found2; break; }
    }
    if (col === -1) {
      console.log(`"Lead ID" column not found in first 10 rows of sheet "${found}"`);
      return [];
    }

    return rows.slice(headerRowIdx + 1)
      .map(r => String(r[col] || '').trim())
      .filter(id => id && id !== 'undefined' && id !== 'null' && id !== 'None');
  }

  const freshIds    = getIdsFromSheet('Fresh');
  const retainedIds = getIdsFromSheet('Retained');
  console.log(`Lead IDs — Fresh: ${freshIds.length}, Retained: ${retainedIds.length}`);
  return { freshIds, retainedIds };
}

export async function fetchGreylabsData(dateStr: string) {
  const auth  = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const target   = new Date(dateStr + 'T00:00:00+05:30');
  const after    = new Date(target); after.setDate(target.getDate() - 1);
  const before   = new Date(target); before.setDate(target.getDate() + 1);
  const afterTs  = Math.floor(after.getTime() / 1000);
  const beforeTs = Math.floor(before.getTime() / 1000);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `from:customreports@greylabs.ai after:${afterTs} before:${beforeTs}`,
    maxResults: 5,
  });
  const messages = res.data.messages;
  if (!messages?.length) { console.log(`GreyLabs email not found for ${dateStr}`); return null; }
  const msg = await gmail.users.messages.get({ userId: 'me', id: messages[0].id!, format: 'full' });
  const body = getEmailBody(msg.data.payload);
  if (!body) return null;
  const funnelData = parseEmailBody(body);
  if (!funnelData) return null;

  let freshIds: string[] = [];
  let retainedIds: string[] = [];
  const parts = msg.data.payload?.parts || [];
  const attachment = findXlsxAttachment(parts);
  if (attachment) {
    try {
      const ids = await extractLeadIds(gmail, messages[0].id!, attachment.attachmentId);
      freshIds = ids.freshIds;
      retainedIds = ids.retainedIds;
    } catch (e: any) { console.log('Could not extract Lead IDs:', e.message); }
  } else {
    console.log('No xlsx attachment found in email');
  }
  return { ...funnelData, freshIds, retainedIds };
}
