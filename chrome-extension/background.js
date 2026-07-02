const SUPERSET_URL = 'https://insurance-analytic-platform.paytminsurance.co.in';
const DATABASE_ID = 3;

async function responseError(response, prefix) {
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error('SUPERSET_AUTH_REQUIRED');
  throw new Error(`${prefix} (${response.status}): ${text.slice(0, 500)}`);
}

async function runQuery(sql) {
  const normalized = sql.trim();
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|CALL)\b/i;
  if ((!/^WITH\b/i.test(normalized) && !/^SELECT\b/i.test(normalized)) || forbidden.test(normalized) || !normalized.includes('hive.recent_search.enser_callback_data_snapshot_v3')) {
    throw new Error('Query rejected by the Voicebot Superset Bridge allowlist');
  }
  const csrfResponse = await fetch(`${SUPERSET_URL}/api/v1/security/csrf_token/`, { credentials: 'include', headers: { Accept: 'application/json', Referer: `${SUPERSET_URL}/sqllab/` } });
  if (!csrfResponse.ok) await responseError(csrfResponse, 'Could not get Superset CSRF token');
  const csrf = (await csrfResponse.json()).result;
  const queryResponse = await fetch(`${SUPERSET_URL}/api/v1/sqllab/execute/`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf, Referer: `${SUPERSET_URL}/sqllab/` },
    body: JSON.stringify({ database_id: DATABASE_ID, sql: normalized, runAsync: false, select_as_cta: false, tmp_table_name: '', client_id: crypto.randomUUID() }),
  });
  if (!queryResponse.ok) await responseError(queryResponse, 'Superset query failed');
  const payload = await queryResponse.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'Superset query failed');
  return payload.data || payload.result?.data || [];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'RUN_QUERY' || typeof message.sql !== 'string') return;
  runQuery(message.sql).then(data => sendResponse({ success: true, data })).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
