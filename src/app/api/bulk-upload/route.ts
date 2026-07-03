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
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function extractDateFromCell(text: string): string | null {
  // 'Fresh Lead Funnel — 29 Jun 2026 (11,491 leads)'
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_MAP[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2,'0')}`;
}

async function saveLeadIds(date: string, freshIds: string[], retainedIds: string[]) {
  const payload = JSON.stringify({ freshIds, retainedIds, allIds: [...freshIds, ...retainedIds] });
  const url   = process.env.UPSTASH_REDIS_REST_URL;
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

function getIdsFromCol(ws: XLSX.WorkSheet, col: number, maxRow: number): string[] {
  const ids: string[] = [];
  for (let r = 4; r <= maxRow; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r: r-1, c: col-1 })];
    if (!cell) continue;
    const v = String(cell.v ?? '').trim();
    if (v && v !== 'Lead ID' && v !== 'undefined' && v !== 'null' && v !== 'None') ids.push(v);
  }
  return ids;
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
        const buffer  = await file.arrayBuffer();
        const wb      = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
        const results_for_file = [];

        // Check if this is a multi-sheet file (one sheet per date like "23 Jun")
        // or a single-sheet file (Sheet1 with date in A1)
        const isMultiSheet = wb.SheetNames.some(n => /^\d{1,2}\s+[A-Za-z]{3}/.test(n.trim()));

        const sheetsToProcess = isMultiSheet
          ? wb.SheetNames.filter(n => /^\d{1,2}\s+[A-Za-z]{3}/.test(n.trim()))
          : wb.SheetNames.slice(0, 1); // just first sheet

        for (const sheetName of sheetsToProcess) {
          const ws      = wb.Sheets[sheetName];
          const range   = XLSX.utils.decode_range(ws['!ref'] || 'A1');
          const maxRow  = range.e.r + 1;

          // Get date — from sheet name or from cell A1
          let date: string | null = null;
          if (isMultiSheet) {
            const parts = sheetName.trim().split(' ');
            const mon   = MONTH_MAP[parts[1]?.toLowerCase() || ''];
            if (mon) date = `2026-${mon}-${parts[0].padStart(2,'0')}`;
          } else {
            // Try filename first
            date = extractDateFromFilename(filename);
            // Fallback: read from cell A1
            if (!date) {
              const a1 = ws[XLSX.utils.encode_cell({r:0, c:0})];
              if (a1) date = extractDateFromCell(String(a1.v || ''));
            }
          }

          if (!date) {
            results.push({ filename, success: false, error: `Could not determine date for sheet "${sheetName}"` });
            continue;
          }

          // Summary row is row 2 (index 1)
          // Fresh summary: col A (col 1), Retained summary: col H (col 8)
          const freshSummaryCell = ws[XLSX.utils.encode_cell({r:1, c:0})];
          const retSummaryCell   = ws[XLSX.utils.encode_cell({r:1, c:7})];
          const freshSummary     = String(freshSummaryCell?.v || '');
          const retSummary       = String(retSummaryCell?.v || '');

          if (!freshSummary || !extractNum('Leads', freshSummary)) {
            results.push({ filename, date, success: false, error: 'Could not parse Fresh funnel summary from row 2 col A' });
            continue;
          }

          const fresh = {
            sent:      extractNum('Leads', freshSummary),
            dialled:   extractNum('Leads', freshSummary),
            connected: extractNum('Connected', freshSummary),
            qualified: extractNum('Qualified', freshSummary),
            high:      extractNum('High', freshSummary),
            medium:    extractNum('Med', freshSummary),
            callback:  extractNum('Callback', freshSummary),
            low:       extractNum('Low', freshSummary),
          };
          const ret = retSummary ? {
            sent:      extractNum('Leads', retSummary),
            dialled:   extractNum('Leads', retSummary),
            connected: extractNum('Connected', retSummary),
            qualified: extractNum('Qualified', retSummary),
            high:      extractNum('High', retSummary),
            medium:    extractNum('Med', retSummary),
            callback:  extractNum('Callback', retSummary),
            low:       extractNum('Low', retSummary),
          } : null;

          // Lead IDs: col A = fresh (col 1), col H = retained (col 8), from row 4
          const freshIds    = getIdsFromCol(ws, 1, maxRow);
          const retainedIds = ret ? getIdsFromCol(ws, 8, maxRow) : [];

          await saveGreylabsOnly(date, {
            fresh_sent: fresh.sent, fresh_dialled: fresh.dialled,
            fresh_connected: fresh.connected, fresh_qualified: fresh.qualified,
            fresh_high: fresh.high, fresh_medium: fresh.medium,
            fresh_low: fresh.low, fresh_callback: fresh.callback,
            ...(ret ? {
              ret_sent: ret.sent, ret_dialled: ret.dialled,
              ret_connected: ret.connected, ret_qualified: ret.qualified,
              ret_high: ret.high, ret_medium: ret.medium,
              ret_low: ret.low, ret_callback: ret.callback,
            } : {}),
          });

          if (freshIds.length || retainedIds.length) {
            await saveLeadIds(date, freshIds, retainedIds);
          }

          results.push({
            filename: isMultiSheet ? `${filename} → ${date}` : filename,
            date, success: true,
            fresh: { sent: fresh.sent, qualified: fresh.qualified },
            retained: ret ? { sent: ret.sent, qualified: ret.qualified } : null,
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
