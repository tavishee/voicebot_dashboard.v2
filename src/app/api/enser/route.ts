import { NextResponse } from 'next/server';
import { saveEnserOnly } from '@/lib/storage';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file     = formData.get('image') as File;
      const date     = formData.get('date') as string;

      if (!file) return NextResponse.json({ error: 'No image provided' }, { status: 400 });
      if (!date) return NextResponse.json({ error: 'No date provided' }, { status: 400 });

      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return NextResponse.json({ error: 'Groq API key not configured' }, { status: 500 });

      const buffer   = await file.arrayBuffer();
      const base64   = Buffer.from(buffer).toString('base64');
      const mimeType = file.type || 'image/jpeg';

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `This is an L5 Leads Summary table with multiple date columns. Extract the data for the column matching the date ${date} (format DD-Mon-YY, e.g. 27-Jun-26).

Return ONLY a raw JSON object, no markdown, no explanation, with these exact keys:
{
  "cc_sent": <Leads Count as integer>,
  "cc_attempted": <Attempted as integer>,
  "cc_connected": <Connected as integer>,
  "cc_churn": <Churn as number>,
  "cc_conversion_on_connect": <Conversion on Connect % as number, e.g. 1.9% becomes 1.9>,
  "l2o_pct": <L2O% Same Day as number, e.g. 1.1% becomes 1.1>
}`
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}` }
              }
            ]
          }],
          temperature: 0,
        }),
      });

      if (!groqRes.ok) {
        const err = await groqRes.text();
        return NextResponse.json({ error: 'Groq API error: ' + err }, { status: 500 });
      }

      const groqData = await groqRes.json();
      const text = groqData.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      const cc_converted = Math.round((parsed.l2o_pct / 100) * parsed.cc_sent);

      const enserData = {
        cc_sent:                  Number(parsed.cc_sent)                  || 0,
        cc_attempted:             Number(parsed.cc_attempted)             || 0,
        cc_connected:             Number(parsed.cc_connected)             || 0,
        cc_converted,
        cc_churn:                 Number(parsed.cc_churn)                 || 0,
        cc_conversion_on_connect: Number(parsed.cc_conversion_on_connect) / 100 || 0,
      };

      await saveEnserOnly(date, enserData);
      return NextResponse.json({ success: true, date, parsed: enserData });
    }

    const body = await request.json();
    const { date, cc_sent, cc_attempted, cc_connected, cc_converted, cc_churn, cc_conversion_on_connect } = body;
    if (!date) return NextResponse.json({ error: 'Date required' }, { status: 400 });
    await saveEnserOnly(date, {
      cc_sent:                  Number(cc_sent)                  || 0,
      cc_attempted:             Number(cc_attempted)             || 0,
      cc_connected:             Number(cc_connected)             || 0,
      cc_converted:             Number(cc_converted)             || 0,
      cc_churn:                 Number(cc_churn)                 || 0,
      cc_conversion_on_connect: Number(cc_conversion_on_connect) / 100 || 0,
    });
    return NextResponse.json({ success: true, date });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
