import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const maxDuration = 60;

function extractNumber(label: string, text: string): number {
  const pattern = new RegExp(label + '[^0-9]*([0-9,]+)', 'i');
  const match = text.match(pattern);
  return match ? parseInt(match[1].replace(/,/g, '')) : 0;
}

function getIdsFromSheet(wb: XLSX.WorkBook, sheetName: string): string[] {
  const found = wb.SheetNames.find(n => n.toLowerCase().includes(sheetName.toLowerCase()));
  if (!found) return [];
  const ws = wb.Sheets[found];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let headerRowIdx = -1, col = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const headers = rows[i].map((h: any) => String(h || '').trim().toLowerCase());
    const f = headers.findIndex(h => h === 'lead id' || h === 'lead_id' || h === 'leadid');
    if (f !== -1) { headerRowIdx = i; col = f; break; }
  }
  if (col === -1) return [];
  return rows.slice(headerRowIdx + 1)
    .map(r => String(r[col] || '').trim())
    .filter(id => id && id !== 'undefined' && id !== 'null' && id !== 'None');
}

function getSummaryFromSheet(wb: XLSX.WorkBook, sheetName: string) {
  const found = wb.SheetNames.find(n => n.toLowerCase().includes(sheetName.toLowerCase()));
  if (!found) return null;
  const ws = wb.Sheets[found];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  // Find summary row — look for row with "Total Leads" in first 10 rows
  let summaryText = '';
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const rowStr = rows[i].map((c: any) => String(c || '')).join(' ');
    summaryText += ' ' + rowStr;
  }
  return {
    sent:      extractNumber('Total Leads', summaryText),
    dialled:   extractNumber('Total Dialed', summaryText),
    connected: extractNumber('Total Connected', summaryText),
    qualified: extractNumber('Total Qualified', summaryText),
    high:      extractNumber('High Intent', summaryText),
    medium:    extractNumber('Medium Intent', summaryText),
    low:       extractNumber('Low Intent', summaryText),
    callback:  extractNumber('Callback with Agent', summaryText),
  };
}

function extractDateFromFilename(filename: string): string | null {
  // Match patterns like 2026-06-28, 28-Jun-26, 2026_06_28
  const patterns = [
    /(\d{4}-\d{2}-\d{2})/,
    /(\d{2})-([A-Za-z]{3})-(\d{2})/,
    /(\d{4})_(\d{2})_(\d{2})/,
  ];
  for (const p of patterns) {
    const m = filename.match(p);
    if (m) {
      if (m[0].includes('-') && m[0].length === 10) return m[0];
      if (m[2] && isNaN(Number(m[2]))) {
        // DD-Mon-YY format
        const months: Record<string, string> = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
        const mon = months[m[2].toLowerCase()];
        if (mon) return `20${m[3]}-${mon}-${m[1].padStart(2,'0')}`;
      }
      if (m[1] && m[2] && m[3]) return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return null;
}

async function saveLeadIds(date: string, freshIds: string[], retainedIds: string[]) {
  const payload = JSON.stringify({ freshIds, retainedIds, allIds: [...freshIds, ...retainedIds] });
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const redis = new Redis({ url, token });
    await redis.set(`lead_ids:${date}`, payload);
    await redis.expire(`lead_ids:${date}`, 60 * 60 * 24 * 90);
  } else {
    const dir = resolve(process.cwd(), '.data');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `lead_ids_${date}.json`), payload);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 });

    const results = [];

    for (const file of files) {
      const filename = file.name;
      const date = extractDateFromFilename(filename);
      if (!date) {
        results.push({ filename, success: false, error: 'Could not extract date from filename' });
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buffer), { type: 'buffer' });

        const fresh    = getSummaryFromSheet(wb, 'Fresh');
        const retained = getSummaryFromSheet(wb, 'Retained');
        const freshIds    = getIdsFromSheet(wb, 'Fresh');
        const retainedIds = getIdsFromSheet(wb, 'Retained');

        if (!fresh?.sent) {
          results.push({ filename, date, success: false, error: 'Could not parse Fresh Lead Funnel summary' });
          continue;
        }

        await saveGreylabsOnly(date, {
          fresh_sent: fresh.sent, fresh_dialled: fresh.dialled, fresh_connected: fresh.connected,
          fresh_qualified: fresh.qualified, fresh_high: fresh.high, fresh_medium: fresh.medium,
          fresh_low: fresh.low, fresh_callback: fresh.callback,
          ...(retained ? {
            ret_sent: retained.sent, ret_dialled: retained.dialled, ret_connected: retained.connected,
            ret_qualified: retained.qualified, ret_high: retained.high, ret_medium: retained.medium,
            ret_low: retained.low, ret_callback: retained.callback,
          } : {}),
        });

        if (freshIds.length || retainedIds.length) {
          await saveLeadIds(date, freshIds, retainedIds);
        }

        results.push({
          filename, date, success: true,
          fresh: { sent: fresh.sent, qualified: fresh.qualified },
          retained: retained ? { sent: retained.sent, qualified: retained.qualified } : null,
          leadIds: { fresh: freshIds.length, retained: retainedIds.length },
        });
      } catch (e: any) {
        results.push({ filename, date, success: false, error: e.message });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
