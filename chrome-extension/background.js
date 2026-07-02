const SUPERSET_URL = 'https://insurance-analytic-platform.paytminsurance.co.in';
const DATABASE_ID = 3;

function validateQuery(sql) {
  const normalized = sql.trim();
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|CALL)\b/i;
  if ((!/^WITH\b/i.test(normalized) && !/^SELECT\b/i.test(normalized)) || forbidden.test(normalized) || !normalized.includes('hive.recent_search.enser_callback_data_snapshot_v3')) {
    throw new Error('Query rejected by the Voicebot Superset Bridge allowlist');
  }
  return normalized;
}

async function runQueryInSupersetTab(sql) {
  const tabs = await chrome.tabs.query({ url: `${SUPERSET_URL}/*` });
  const tab = tabs.find(candidate => candidate.id);
  if (!tab?.id) throw new Error('SUPERSET_TAB_REQUIRED');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN', args: [sql, DATABASE_ID, SUPERSET_URL],
    func: async (query, databaseId, baseUrl) => {
      try {
        const csrfResponse = await fetch(`${baseUrl}/api/v1/security/csrf_token/`, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (csrfResponse.status === 401 || csrfResponse.status === 403) return { error: 'SUPERSET_AUTH_REQUIRED' };
        if (!csrfResponse.ok) return { error: `CSRF request failed (${csrfResponse.status}): ${(await csrfResponse.text()).slice(0, 500)}` };
        const csrf = (await csrfResponse.json()).result;
        const queryResponse = await fetch(`${baseUrl}/api/v1/sqllab/execute/`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf },
          body: JSON.stringify({ database_id: databaseId, sql: query, runAsync: false, select_as_cta: false, tmp_table_name: '', client_id: crypto.randomUUID() }),
        });
        if (queryResponse.status === 401 || queryResponse.status === 403) return { error: 'SUPERSET_AUTH_REQUIRED' };
        if (!queryResponse.ok) return { error: `Query failed (${queryResponse.status}): ${(await queryResponse.text()).slice(0, 1000)}` };
        const payload = await queryResponse.json();
        if (payload.errors?.length) return { error: payload.errors[0].message || 'Superset query failed' };
        return { data: payload.data || payload.result?.data || [] };
      } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    },
  });
  const result = results[0]?.result;
  if (!result) throw new Error('Superset tab did not return a result');
  if (result.error) throw new Error(result.error);
  return result.data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'RUN_QUERY' || typeof message.sql !== 'string') return;
  try {
    const sql = validateQuery(message.sql);
    runQueryInSupersetTab(sql).then(data => sendResponse({ success: true, data })).catch(error => sendResponse({ success: false, error: error.message }));
  } catch (error) { sendResponse({ success: false, error: error.message }); return; }
  return true;
});
