import { NextResponse } from 'next/server';
import { saveEnserOnly } from '@/lib/storage';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    // Handle image upload — parse with Gemini
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file     = formData.get('image') as File;
      const date     = formData.get('date') as string;

      if (!file) return NextResponse.json({ error: 'No image provided' }, { status: 400 });
      if (!date) return NextResponse.json({ error: 'No date provided' }, { status: 400 });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });

      // Convert file to base64
      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mimeType = file.type || 'image/jpeg';

      // Call Gemini API
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  inline_data: { mime_type: mimeType, data: base64 }
                },
                {
                  text: `This is an L5 Leads Summary table. Extract the data for the date column that matches or is closest to ${date}.
                  
Return ONLY a JSON object with these exact keys (numbers only, no % signs):
{
  "cc_sent": <Leads Count>,
  "cc_attempted": <Attempted>,
  "cc_connected": <Connected>,
  "cc_churn": <Churn>,
  "cc_conversion_on_connect": <Conversion on Connect % as decimal e.g. 1.9% = 1.9>,
  "l2o_pct": <L2O% Same Day as decimal e.g. 1.1% = 1.1>
}

Return only the JSON, no explanation, no markdown.`
                }
              ]
            }],
            generationConfig: { temperature: 0 }
          })
        }
      );

      if (!geminiRes.ok) {
        const err = await geminiRes.text();
        return NextResponse.json({ error: 'Gemini API error: ' + err }, { status: 500 });
      }

      const geminiData = await geminiRes.json();
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // Parse JSON from Gemini response
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      // Compute converted from L2O% × leads sent
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

    // Handle manual JSON entry (fallback)
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
