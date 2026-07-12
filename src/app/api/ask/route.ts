import { NextResponse } from 'next/server';

const SCHEMA_CONTEXT = `
You have access to these Superset/Trino tables:

1. recent_search.enser_callback_data_snapshot_v3 — every call GreyLabs bot AND Enser call centre make
   Columns: id, lead_id, customer_id, phone_number, call_number, registration_number, service,
     agent, batch, call_type, disposition1, disposition2, disposition3, start_time (TIMESTAMP),
     end_time, duration, ring_duration, talk_duration, wrapup_duration, next_call_time,
     created_on, modified_on, source (VARCHAR — 'greylabs' for bot calls, 'enser' for call centre),
     intent (VARCHAR — 'High Intent'/'Medium Intent'/'Low Intent'/'Callback with Agent', only reliably
     populated for the last ~2 days), dl_last_updated (DATE — REQUIRED partition filter, always include
     "dl_last_updated >= date('X') AND dl_last_updated <= date('Y')" with a reasonably tight range).

2. paytm_ct_reports.cdo_insurance_motor_snapshot_v3 — CleverTap events, the bridge between GreyLabs
   and the call centre. Columns include: eventprops_customerid (customer id), eventprops_extrafield59
   (this holds the intent/qualification tag: 'High Intent'/'Medium Intent'/'Callback with Agent'),
   ts (VARCHAR timestamp in format YYYYMMDDHHMMSS), dl_last_updated (DATE — REQUIRED partition filter,
   must use "dl_last_updated = date('X')" or a range).

3. marketplace.sales_order_snapshot_v3 (alias a) — orders/policy purchases.
   Columns: customer_id, id, created_at (TIMESTAMP), dl_last_updated (DATE — REQUIRED partition filter).
   Join to marketplace.sales_order_item_snapshot_v3 (alias b) ON a.id = b.order_id.
   Columns on b: order_id, vertical_id (173 = Motor), name (policy product name), dl_last_updated.
   To exclude non-motor / non-4-wheeler products, add:
   b.name NOT IN ('Health Insurance','Health Advantage Plus','HDFC Life Term Insurance',
   'Term Life Insurance','Compulsory Personal Accident 4W','Compulsory Personal Accident 2W',
   'Two Wheeler Insurance','Compulsory Personal Accident 2W - Standalone')

Rules for generated SQL:
- SELECT statements only, never INSERT/UPDATE/DELETE/DROP/ALTER.
- Always include the dl_last_updated partition filter on every table used — this is mandatory or
  the query will be rejected by Trino.
- Use Trino syntax: date('YYYY-MM-DD'), date_diff('day', date1, date2) — NOT MySQL's DATEDIFF().
  TRY_CAST(x AS INT) for safe casting. SPLIT_PART(str, delim, index) for splitting talk_duration.
- Always add a LIMIT clause (max 200) unless the question is clearly an aggregate (COUNT/SUM/AVG).
- Today's date is ${new Date().toISOString().slice(0,10)}.
`;

export async function POST(request: Request) {
  try {
    const { stage, question, sql, rows, error } = await request.json();
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'Groq API key not configured' }, { status: 500 });

    if (stage === 'generate_sql') {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: `You are a SQL generator for a Trino/Superset data warehouse. ${SCHEMA_CONTEXT}\n\nRespond with ONLY a raw JSON object, no markdown, no explanation: {"sql": "...", "explanation": "one sentence describing what this query does"}. If the question can't be answered with these tables, respond {"sql": null, "explanation": "why not"}.` },
            { role: 'user', content: question },
          ],
          temperature: 0.1,
        }),
      });
      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || '{}';
      const cleaned = text.replace(/```json|```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(cleaned); } catch { parsed = { sql: null, explanation: 'Could not parse LLM response' }; }
      return NextResponse.json(parsed);
    }

    if (stage === 'summarize') {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are a helpful data analyst. Given a question, the SQL query that was run, and the raw result rows, give a clear, concise, direct answer in plain English. Use actual numbers from the data. Keep it to 2-4 sentences unless the data needs a short list or table.' },
            { role: 'user', content: `Question: ${question}\n\nSQL run:\n${sql}\n\nResults (JSON):\n${JSON.stringify(rows).slice(0, 8000)}\n\n${error ? `Note: query errored: ${error}` : ''}` },
          ],
          temperature: 0.2,
        }),
      });
      const data = await groqRes.json();
      const answer = data.choices?.[0]?.message?.content || 'Could not generate an answer.';
      return NextResponse.json({ answer });
    }

    return NextResponse.json({ error: 'Invalid stage' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
