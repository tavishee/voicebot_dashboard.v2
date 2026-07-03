import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { saveGreylabsOnly } from '@/lib/storage';
import { Redis } from '@upstash/redis';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const maxDuration = 60;

const MONTH_MAP: Record<string,string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'
};

function extractNum(label: string, text: string): number {
  const m = text.match(new RegExp(label + '[^0-9]*([0-9,]+)', 'i'));
  return m ? parseInt(m[1].replace(/,/g,'')) : 0;
}

function extractDateFromFilename(filename: string): string | null {
  const p1 = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (p1) return p1[1];
  const p2 = filename.match(/(\d{2})-([A-Za-z]{3})-(\d{2})/);
  if (p2) { const m = MONTH_MAP[p2[2].toLowerCase()]; if (m) return `20${p2[3]}-${m}-${p2[1].padStart(2,'0')}`; }
  const p3 = filename.match(/(\d{4})_(\d{2})_(\d{2})/);
  if (p3) return `${p3[1]}-${p3[2]}-${p3[3]}`;
  return null;
}

function parseSheetDate(sheetName: string): string | null {
  // '23 Jun' or '23 Jun 2026' -> '2026-06-23'
  const m = sheetName.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})(?:\s+\d{4})?$/);
  if (!m) return null;
  const mon = MONTH_MAP[m[2].toLowerCase()];
  if (!mon) return null;
  return `2026-${mon}-${m[1].padStart(2,'0')}`;
}

function getIdsFromColumn(ws: XLSX.WorkSheet, col: number, startRow: number, maxRow: number): string[] {
  const ids: string[] = [];
  for (let r = startRow; r <= maxRow; r++) {
    const cell = ws[XLSX.utils.encode_cell({r: r-1, c: col-1})];
    if (!cell) continue;
    const v = String(cell.v || '').trim();
    if (v && v !== 'Lead ID' && v !== 'undefined' && v !== 'null' && v !== 'None') ids.push(v);
  }
  return ids;
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

// Format 1: daily file with separate sheets "Fresh Lead Funnel" and "Retained Lead Funnel"
function parseDailyFormat(wb: XLSX.WorkBook, date: string) {
  function getSheet(name: string) {
    return wb.SheetNames.find(n => n.toLowerCase().includes(name.toLowerCase()));
  }

  function getIdsFromSheet(sheetName: string): string[] {
    const found = getSheet(sheetName);
    if (!found) return [];
    const ws = wb.Sheets[found];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let col = -1, headerRow = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const headers = rows[i].map((h: any) => String(h||'').trim().toLowerCase());
      const f = headers.findIndex((h: string) => h === 'lead id' || h === 'lead_id');
      if (f !== -1) { headerRow = i; col = f; break; }
    }
    if (col === -1) return [];
    return rows.slice(headerRow+1).map(r => String(r[col]||'').trim()).filter(id => id && id !== 'undefined' && id !== 'None');
  }

  function getSummary(sheetName: string) {
    const found = getSheet(sheetName);
    if (!found) return null;
    const ws = wb.Sheets[found];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let text = '';
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      text += ' ' + rows[i].map((c: any) => String(c||'')).join(' ');
    }
    return {
      sent: extractNum('Total Leads', text),
      dialled: extractNum('Total Dialed', text),
      connected: extractNum('Total Connected', text) || extractNum('Connected', text),
      qualified: extractNum('Total Qualified', text) || extractNum('Qualified', text),
      high: extractNum('High Intent', text),
      medium: extractNum('Medium Intent', text),
      low: extractNum('Low Intent', text),
      callback: extractNum('Callback with Agent', text) || extractNum('Callback', text),
    };
  }

  const fresh = getSummary('Fresh');
  const retained = getSummary('Retained');
  const freshIds = getIdsFromSheet('Fresh');
  const retainedIds = getIdsFromSheet('Retained');
  return { fresh, retained, freshIds, retainedIds };
}

// Format 2: multi-day file with one sheet per date, Fresh (cols A-F) + Retained (cols H-M) side by side
function parseMultiDayFormat(wb: XLSX.WorkBook): Array<{date:string, fresh:any, retained:any, freshIds:string[], retainedIds:string[]}> {
  const results = [];
  for (const sheetName of wb.SheetNames) {
    const date = parseSheetDate(sheetName);
    if (!date) continue;
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const maxRow = range.e.r + 1;

    // Row 2 (index 1) has the summary text in col A (fresh) and col H (retained)
    const freshSummaryCell = ws[XLSX.utils.encode_cell({r:1, c:0})];
    const retSummaryCell   = ws[XLSX.utils.encode_cell({r:1, c:7})];
    const freshSummary = String(freshSummaryCell?.v || '');
    const retSummary   = String(retSummaryCell?.v || '');

    const fresh = {
      sent:      extractNum('Leads', freshSummary),
      dialled:   extractNum('Leads', freshSummary), // no dialled in this format
      connected: extractNum('Connected', freshSummary),
      qualified: extractNum('Qualified', freshSummary),
      high:      extractNum('High', freshSummary),
      medium:    extractNum('Med', freshSummary),
      callback:  extractNum('Callback', freshSummary),
      low:       extractNum('Low', freshSummary),
    };
    const retained = {
      sent:      extractNum('Leads', retSummary),
      dialled:   extractNum('Leads', retSummary),
      connected: extractNum('Connected', retSummary),
      qualified: extractNum('Qualified', retSummary),
      high:      extractNum('High', retSummary),
      medium:    extractNum('Med', retSummary),
      callback:  extractNum('Callback', retSummary),
      low:       extractNum('Low', retSummary),
    };

    // Lead IDs: col A = fresh (col index 0), col H = retained (col index 7), starting row 4
    const freshIds    = getIdsFromColumn(ws, 1, 4, maxRow);
    const retainedIds = getIdsFromColumn(ws, 8, 4, maxRow);

    results.push({ date, fresh, retained, freshIds, retainedIds });
  }
  return results;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 });

    const results = [];

    for (const file of files) {
      const filename = file.name;
      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buffer), { type: 'buffer' });

        // Detect format: if sheet names look like dates (e.g. "23 Jun") = multi-day format
        const isMultiDay = wb.SheetNames.some(n => /^\d{1,2}\s+[A-Za-z]{3}/.test(n.trim()));

        if (isMultiDay) {
          // Multi-day: one sheet per date
          const days = parseMultiDayFormat(wb);
          if (!days.length) { results.push({ filename, success: false, error: 'No date sheets found' }); continue; }

          for (const { date, fresh, retained, freshIds, retainedIds } of days) {
            await saveGreylabsOnly(date, {
              fresh_sent: fresh.sent, fresh_dialled: fresh.dialled, fresh_connected: fresh.connected,
              fresh_qualified: fresh.qualified, fresh_high: fresh.high, fresh_medium: fresh.medium,
              fresh_low: fresh.low, fresh_callback: fresh.callback,
              ret_sent: retained.sent, ret_dialled: retained.dialled, ret_connected: retained.connected,
              ret_qualified: retained.qualified, ret_high: retained.high, ret_medium: retained.medium,
              ret_low: retained.low, ret_callback: retained.callback,
            });
            if (freshIds.length || retainedIds.length) {
              await saveLeadIds(date, freshIds, retainedIds);
            }
            results.push({
              filename: `${filename} → ${date}`, date, success: true,
              fresh: { sent: fresh.sent, qualified: fresh.qualified },
              retained: { sent: retained.sent, qualified: retained.qualified },
              leadIds: { fresh: freshIds.length, retained: retainedIds.length },
            });
          }
        } else {
          // Daily format: single date from filename
          const date = extractDateFromFilename(filename);
          if (!date) { results.push({ filename, success: false, error: 'Could not extract date from filename' }); continue; }

          const { fresh, retained, freshIds, retainedIds } = parseDailyFormat(wb, date);
          if (!fresh?.sent) { results.push({ filename, date, success: false, error: 'Could not parse Fresh Lead Funnel summary' }); continue; }

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
        }
      } catch (e: any) {
        results.push({ filename, success: false, error: e.message });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
