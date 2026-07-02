import { NextResponse } from 'next/server';
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

function findAttachments(parts: any[], result: any[] = []): any[] {
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      result.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
    }
    if (part.parts) findAttachments(part.parts, result);
  }
  return result;
}

export async function GET(request: Request) {
  try {
    const url  = new URL(request.url);
    const date = url.searchParams.get('date') || '2026-06-28';

    const auth  = getOAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const target   = new Date(date + 'T00:00:00+05:30');
    const after    = new Date(target); after.setDate(target.getDate() - 1);
    const before   = new Date(target); before.setDate(target.getDate() + 1);
    const afterTs  = Math.floor(after.getTime() / 1000);
    const beforeTs = Math.floor(before.getTime() / 1000);

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `from:customreports@greylabs.ai after:${afterTs} before:${beforeTs}`,
      maxResults: 5,
    });

    if (!res.data.messages?.length) {
      return NextResponse.json({ error: 'No emails found' });
    }

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: res.data.messages[0].id!,
      format: 'full',
    });

    const attachments = findAttachments(msg.data.payload?.parts || []);

    // Try to read the first xlsx attachment
    let sheetInfo: any = null;
    const xlsxAtt = attachments.find(a => a.filename?.toLowerCase().endsWith('.xlsx') || a.filename?.toLowerCase().endsWith('.xls'));
    
    if (xlsxAtt) {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: res.data.messages[0].id!,
        id: xlsxAtt.attachmentId,
      });
      const buffer = Buffer.from(att.data.data, 'base64');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      sheetInfo = {
        sheetNames: wb.SheetNames,
        sheets: {} as any,
      };
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
        sheetInfo.sheets[name] = {
          rowCount: rows.length,
          headers: rows[0] || [],
          firstDataRow: rows[1] || [],
        };
      }
    }

    return NextResponse.json({
      emailFound: true,
      subject: msg.data.payload?.headers?.find((h: any) => h.name === 'Subject')?.value,
      attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType })),
      xlsxFound: !!xlsxAtt,
      sheetInfo,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message });
  }
}
