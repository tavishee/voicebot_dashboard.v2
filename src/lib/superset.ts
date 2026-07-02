// ============================================================
// SUPERSET CONNECTION — Cookie-based auth
// User logs into Superset via Google SSO in browser,
// dashboard forwards that session cookie to query data.
// ============================================================

const SUPERSET_URL = 'https://insurance-analytic-platform.paytminsurance.co.in';
export const SUPERSET_LOGIN_URL = `${SUPERSET_URL}/login/`;

// StarRocks_default_catalog — confirmed database ID from earlier
const STARROCKS_DB_ID = 11;

// ── RUN SQL QUERY AGAINST SUPERSET/STARROCKS ────────────────
export async function runSQL(sql: string, sessionCookie: string): Promise<any[]> {
  // Get CSRF token using the user's session cookie
  const csrfRes = await fetch(`${SUPERSET_URL}/api/v1/security/csrf_token/`, {
    headers: {
      'Cookie': sessionCookie,
      'Referer': SUPERSET_URL,
    },
  });

  if (csrfRes.status === 401 || csrfRes.status === 403) throw new Error('SUPERSET_AUTH_REQUIRED');
  if (!csrfRes.ok) throw new Error('Could not get CSRF token: ' + csrfRes.status);

  const { result: csrfToken } = await csrfRes.json();

  const res = await fetch(`${SUPERSET_URL}/api/v1/sqllab/execute/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'Referer': SUPERSET_URL,
      'X-CSRFToken': csrfToken,
    },
    body: JSON.stringify({
      database_id: STARROCKS_DB_ID,
      sql: sql.trim(),
      runAsync: false,
      select_as_cta: false,
      tmp_table_name: '',
      // NOTE: client_id intentionally omitted — Superset's internal
      // `query` table caps it at varchar(11), so we let Superset
      // generate its own short ID instead of sending one.
    }),
  });

  if (res.status === 401 || res.status === 403) throw new Error('SUPERSET_AUTH_REQUIRED');
  if (!res.ok) throw new Error('Query failed: ' + (await res.text()));

  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data || [];
}

// ============================================================
// ENSER QUERIES — PLACEHOLDERS
// Replace these two SQL strings with your real CDR and
// converted-leads queries. Keep the column aliases the same
// (date, cc_sent, cc_attempted, cc_connected, cc_converted,
// cc_churn, cc_conversion_on_connect) so nothing else needs
// to change downstream.
// ============================================================

const CDR_SQL_PLACEHOLDER = `
  -- PLACEHOLDER: replace with your real CDR query
  -- Must return columns: date, cc_sent, cc_attempted, cc_connected
  SELECT
    DATE(call_date) AS date,
    COUNT(*) AS cc_sent,
    SUM(CASE WHEN attempted = 1 THEN 1 ELSE 0 END) AS cc_attempted,
    SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) AS cc_connected
  FROM your_cdr_table
  WHERE call_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
  GROUP BY DATE(call_date)
`;

const CONVERTED_SQL_PLACEHOLDER = `
  -- PLACEHOLDER: replace with your real converted-leads query
  -- Must return columns: date, cc_converted
  SELECT
    DATE(conversion_date) AS date,
    COUNT(*) AS cc_converted
  FROM your_converted_leads_table
  WHERE conversion_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
  GROUP BY DATE(conversion_date)
`;

// ── FETCH AND MERGE ENSER DATA ───────────────────────────────
export async function fetchEnserRowsFromSuperset(sessionCookie: string) {
  const [cdrRows, convertedRows] = await Promise.all([
    runSQL(CDR_SQL_PLACEHOLDER, sessionCookie),
    runSQL(CONVERTED_SQL_PLACEHOLDER, sessionCookie),
  ]);

  const merged: Record<string, any> = {};

  for (const r of cdrRows) {
    const d = String(r.date).slice(0, 10);
    merged[d] = {
      date: d,
      cc_sent:      Number(r.cc_sent)      || 0,
      cc_attempted: Number(r.cc_attempted) || 0,
      cc_connected: Number(r.cc_connected) || 0,
      cc_converted: 0,
      cc_churn: 0,
      cc_conversion_on_connect: 0,
    };
  }

  for (const r of convertedRows) {
    const d = String(r.date).slice(0, 10);
    if (!merged[d]) merged[d] = { date: d, cc_sent:0, cc_attempted:0, cc_connected:0, cc_converted:0, cc_churn:0, cc_conversion_on_connect:0 };
    merged[d].cc_converted = Number(r.cc_converted) || 0;
  }

  // Derive conversion-on-connect rate
  for (const d in merged) {
    const r = merged[d];
    r.cc_conversion_on_connect = r.cc_connected > 0 ? r.cc_converted / r.cc_connected : 0;
  }

  return Object.values(merged);
}
