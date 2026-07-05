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
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_MAP[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2,'0')}`;
}

function parseExcelDate(val: any): string | null {
  if (!val) return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mon = MONTH_MAP[m[2].toLowerCase()];
    if (!mon) return null;
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${mon}-${m[1].padStart(2,'0')}`;
  }
  return null;
}

async function saveLeadIds(date: string, freshIds: string[], retainedIds: string[], allFreshIds?: string[], allRetainedIds?: string[]) {
  // freshIds/retainedIds = qualified leads only (for retention sync denominator accuracy)
  // allIds = all leads including unqualified (for Superset combinedQuery which needs full set)
  const allIds = [...(allFreshIds||freshIds), ...(allRetainedIds||retainedIds)];
  const payload = JSON.stringify({ freshIds, retainedIds, allIds });
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

async function saveRetentionData(reportDate: string, sheetType: 'fresh'|'retained', rows: any[][]) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  const redis = new Redis({ url, token });

  const cohortMap: Record<string, { connected: number; qualified: number; leads_sent: number }> = {};

  for (const row of rows) {
    const createdDate = parseExcelDate(row[1]);
    if (!createdDate) continue;
    const connected = Number(row[3]) > 0 ? 1 : 0;
    const qualified = row[4] && row[4] !== 'NO' && row[4] !== 'None' && row[4] !== '0' && row[4] !== null ? 1 : 0;
    if (!cohortMap[createdDate]) cohortMap[createdDate] = { connected: 0, qualified: 0, leads_sent: 0 };
    cohortMap[createdDate].connected += connected;
    cohortMap[createdDate].qualified += qualified;
    cohortMap[createdDate].leads_sent += 1;
  }

  for (const [cohortDate, counts] of Object.entries(cohortMap)) {
    const key = `retention:${cohortDate}`;
    const raw = await redis.get<string>(key);
    const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {
      cohort_date: cohortDate, leads_sent: 0, grey: {}, enser: {}
    };

    const cohortMs = new Date(cohortDate).getTime();
    const reportMs = new Date(reportDate).getTime();
    const dayN = Math.round((reportMs - cohortMs) / (1000 * 60 * 60 * 24));
    if (dayN < 0 || dayN > 7) continue;

    if (dayN === 0 && sheetType === 'fresh') {
      existing.leads_sent = counts.leads_sent;
    }

    if (!existing.grey[`day${dayN}`]) existing.grey[`day${dayN}`] = { connected: 0, qualified: 0 };
    existing.grey[`day${dayN}`].connected += counts.connected;
    existing.grey[`day${dayN}`].qualified += counts.qualified;

    await redis.set(key, JSON.stringify(existing));
    await redis.expire(key, 60 * 60 * 24 * 120);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 });

    const results = [];
    const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

    for (const file of files) {
      const filename = file.name;
      try {
        const buffer  = await file.arrayBuffer();
        const wb      = XLSX.read(Buffer.from(buffer), { type: 'buffer' });

        const isMultiSheet = wb.SheetNames.some(n => /^\d{1,2}\s+[A-Za-z]{3}/.test(n.trim()));
        const isFormatA    = wb.SheetNames.some(n => n.toLowerCase().includes('fresh lead funnel'));
        const sheetsToProcess = isMultiSheet
          ? wb.SheetNames.filter(n => /^\d{1,2}\s+[A-Za-z]{3}/.test(n.trim()))
          : [wb.SheetNames[0]];

        for (const sheetName of sheetsToProcess) {
          const ws     = wb.Sheets[sheetName];
          const range  = XLSX.utils.decode_range(ws['!ref'] || 'A1');
          const maxRow = range.e.r + 1;

          // Determine report date
          let reportDate: string | null = null;
          if (isMultiSheet) {
            const parts = sheetName.trim().split(' ');
            const mon = MONTH_MAP[parts[1]?.toLowerCase() || ''];
            if (mon) reportDate = `2026-${mon}-${parts[0].padStart(2,'0')}`;
          } else {
            reportDate = extractDateFromFilename(filename);
            if (!reportDate) {
              const a1 = ws[XLSX.utils.encode_cell({r:0, c:0})];
              if (a1) reportDate = extractDateFromCell(String(a1.v || ''));
            }
          }

          if (!reportDate) {
            results.push({ filename, success: false, error: 'Could not determine date' });
            continue;
          }

          let fresh: any = null, ret: any = null;
          let freshIds: string[] = [], retainedIds: string[] = [];
          let freshRows: any[][] = [], retRows: any[][] = [];

          if (isFormatA) {
            // Format A: separate "Fresh Lead Funnel" and "Retained Lead Funnel" sheets
            const freshSheetName = wb.SheetNames.find(n => n.toLowerCase().includes('fresh lead funnel'));
            const retSheetName   = wb.SheetNames.find(n => n.toLowerCase().includes('retained lead funnel'));

            if (freshSheetName) {
              const fws   = wb.Sheets[freshSheetName];
              const frows: any[][] = XLSX.utils.sheet_to_json(fws, { header: 1 });
              const sum   = frows[2] || [];
              const sumText = frows.slice(0,5).flat().map((x:any) => String(x||'')).join(' ');
              fresh = {
                sent: Number(sum[0])||0, dialled: Number(sum[1])||0,
                connected: Number(sum[2])||0, qualified: Number(sum[3])||0,
                high: extractNum('High', sumText), medium: extractNum('Med', sumText),
                low: extractNum('Low', sumText), callback: extractNum('Callback', sumText),
              };
              const headerIdx = frows.findIndex((r:any[]) => String(r[0]||'').trim().toLowerCase() === 'lead id');
              if (headerIdx >= 0) {
                const fHeaders = (frows[headerIdx]||[]).map((h:any)=>String(h||'').trim().toLowerCase());
                const qualCol = fHeaders.findIndex((h:string)=>h==='qualified');
                freshRows = frows.slice(headerIdx+1).filter((r:any[]) => r[0]);
                // freshIds = only qualified leads (Qualified=YES) for retention sync accuracy
                freshIds  = freshRows
                  .filter((r:any[]) => qualCol<0 || String(r[qualCol]||'').trim().toUpperCase()==='YES')
                  .map((r:any[]) => String(r[0]).trim()).filter(Boolean);
              }
            }

            if (retSheetName) {
              const rws   = wb.Sheets[retSheetName];
              const rrows: any[][] = XLSX.utils.sheet_to_json(rws, { header: 1 });
              const sum   = rrows[2] || [];
              const sumText = rrows.slice(0,5).flat().map((x:any) => String(x||'')).join(' ');
              ret = {
                sent: Number(sum[0])||0, dialled: Number(sum[1])||0,
                connected: Number(sum[2])||0, qualified: Number(sum[3])||0,
                high: extractNum('High', sumText), medium: extractNum('Med', sumText),
                low: extractNum('Low', sumText), callback: extractNum('Callback', sumText),
              };
              const headerIdx = rrows.findIndex((r:any[]) => String(r[0]||'').trim().toLowerCase() === 'lead id');
              if (headerIdx >= 0) {
                const rHeaders = (rrows[headerIdx]||[]).map((h:any)=>String(h||'').trim().toLowerCase());
                const qualColR = rHeaders.findIndex((h:string)=>h==='qualified');
                retRows     = rrows.slice(headerIdx+1).filter((r:any[]) => r[0]);
                // retainedIds = only qualified leads (Qualified=YES) for retention sync accuracy
                retainedIds = retRows
                  .filter((r:any[]) => qualColR<0 || String(r[qualColR]||'').trim().toUpperCase()==='YES')
                  .map((r:any[]) => String(r[0]).trim()).filter(Boolean);
              }
            }
          } else {
            // Format B: Sheet1 with summary in row 2 col A (fresh) and col H (retained)
            const freshSummaryCell = ws[XLSX.utils.encode_cell({r:1, c:0})];
            const retSummaryCell   = ws[XLSX.utils.encode_cell({r:1, c:7})];
            const freshSummary = String(freshSummaryCell?.v || '');
            const retSummary   = String(retSummaryCell?.v || '');

            if (!extractNum('Leads', freshSummary)) {
              results.push({ filename, date: reportDate, success: false, error: 'Could not parse Fresh funnel summary from row 2 col A' });
              continue;
            }

            fresh = {
              sent: extractNum('Leads', freshSummary), dialled: extractNum('Leads', freshSummary),
              connected: extractNum('Connected', freshSummary), qualified: extractNum('Qualified', freshSummary),
              high: extractNum('High', freshSummary), medium: extractNum('Med', freshSummary),
              callback: extractNum('Callback', freshSummary), low: extractNum('Low', freshSummary),
            };
            if (retSummary) {
              ret = {
                sent: extractNum('Leads', retSummary), dialled: extractNum('Leads', retSummary),
                connected: extractNum('Connected', retSummary), qualified: extractNum('Qualified', retSummary),
                high: extractNum('High', retSummary), medium: extractNum('Med', retSummary),
                callback: extractNum('Callback', retSummary), low: extractNum('Low', retSummary),
              };
            }
            for (let r = 4; r <= maxRow; r++) {
              const v1 = ws[XLSX.utils.encode_cell({r:r-1, c:0})];
              const v8 = ws[XLSX.utils.encode_cell({r:r-1, c:7})];
              if (v1?.v && String(v1.v).trim() !== 'Lead ID') freshIds.push(String(v1.v).trim());
              if (v8?.v && String(v8.v).trim() !== 'Lead ID') retainedIds.push(String(v8.v).trim());
            }
          }

          if (!fresh?.sent) {
            results.push({ filename, date: reportDate, success: false, error: 'Could not parse Fresh funnel summary' });
            continue;
          }

          await saveGreylabsOnly(reportDate, {
            fresh_sent: fresh.sent, fresh_dialled: fresh.dialled || fresh.sent,
            fresh_connected: fresh.connected, fresh_qualified: fresh.qualified,
            fresh_high: fresh.high||0, fresh_medium: fresh.medium||0,
            fresh_low: fresh.low||0, fresh_callback: fresh.callback||0,
            ...(ret ? {
              ret_sent: ret.sent, ret_dialled: ret.dialled || ret.sent,
              ret_connected: ret.connected, ret_qualified: ret.qualified,
              ret_high: ret.high||0, ret_medium: ret.medium||0,
              ret_low: ret.low||0, ret_callback: ret.callback||0,
            } : {}),
          });

          // allFreshIds/allRetainedIds = every lead ID (unfiltered) for Superset combinedQuery
          const allFreshIds = isFormatA ? freshRows.map((r:any[]) => String(r[0]).trim()).filter(Boolean) : freshIds;
          const allRetainedIds = isFormatA ? retRows.map((r:any[]) => String(r[0]).trim()).filter(Boolean) : retainedIds;
          if (allFreshIds.length || allRetainedIds.length) {
            await saveLeadIds(reportDate, freshIds, retainedIds, allFreshIds, allRetainedIds);
          }

          if (isFormatA && hasRedis) {
            try {
              if (freshRows.length) await saveRetentionData(reportDate, 'fresh', freshRows);
              if (retRows.length)   await saveRetentionData(reportDate, 'retained', retRows);
            } catch(e:any) {
              console.log('Retention save error:', e.message);
            }
          }

          results.push({
            filename: isMultiSheet ? `${filename} → ${reportDate}` : filename,
            date: reportDate, success: true,
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
