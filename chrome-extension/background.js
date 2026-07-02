const SUPERSET_URL = 'https://insurance-analytic-platform.paytminsurance.co.in';
const DATABASE_CANDIDATES = Array.from({ length: 200 }, (_, index) => index + 1);
let resolvedDatabaseId = null;

function validateQuery(sql) {
  const normalized = sql.trim();
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|CALL)\b/i;
  if ((!/^WITH\b/i.test(normalized) && !/^SELECT\b/i.test(normalized)) || forbidden.test(normalized)
      || (!normalized.includes('recent_search.enser_callback_data') && !normalized.includes('glue_catalog.recent_search_partition.enser_callback_data'))) {
    throw new Error('Query rejected by the Voicebot Superset Bridge allowlist');
  }
  return normalized;
}

async function runQueryInSupersetTab(sql) {
  if (!resolvedDatabaseId) {
    const stored = await chrome.storage.local.get('supersetDatabaseId');
    resolvedDatabaseId = Number(stored.supersetDatabaseId) || null;
  }
  const tabs = await chrome.tabs.query({ url: `${SUPERSET_URL}/*` });
  const tab = tabs.find(candidate => candidate.id);
  if (!tab?.id) throw new Error('SUPERSET_TAB_REQUIRED');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN', args: [sql, resolvedDatabaseId ? [resolvedDatabaseId, ...DATABASE_CANDIDATES.filter(id => id !== resolvedDatabaseId)] : DATABASE_CANDIDATES, SUPERSET_URL],
    func: async (query, databaseCandidates, baseUrl) => {
      try {
        const sqlLabUrl = `${baseUrl}/sqllab/`;
        const csrfResponse = await fetch(`${baseUrl}/api/v1/security/csrf_token/`, { credentials: 'include', headers: { Accept: 'application/json' }, referrer: sqlLabUrl, referrerPolicy: 'strict-origin-when-cross-origin' });
        if (csrfResponse.status === 401 || csrfResponse.status === 403) return { error: 'SUPERSET_AUTH_REQUIRED' };
        if (!csrfResponse.ok) return { error: `CSRF request failed (${csrfResponse.status}): ${(await csrfResponse.text()).slice(0, 500)}` };
        const csrf = (await csrfResponse.json()).result;
        const failures = [];
        let selectedDatabaseId = null;
        const databaseQueries = ['(columns:!(id,database_name),page:0,page_size:200)', '(page:0,page_size:200)'];
        for (const databaseQuery of databaseQueries) {
          try {
            const databaseResponse = await fetch(`${baseUrl}/api/v1/database/?q=${encodeURIComponent(databaseQuery)}`, {
              credentials: 'include', headers: { Accept: 'application/json' }, referrer: sqlLabUrl, referrerPolicy: 'strict-origin-when-cross-origin',
            });
            if (!databaseResponse.ok) { failures.push(`Database API (${databaseResponse.status}): ${(await databaseResponse.text()).slice(-500)}`); continue; }
            const databasePayload = await databaseResponse.json();
            const databases = Array.isArray(databasePayload.result) ? databasePayload.result : [];
            const match = databases.find(item => String(item.database_name || '').toLowerCase() === 'starrocks_glue_catalog') || databases.find(item => String(item.database_name || '').toLowerCase().includes('starrocks'));
            if (match?.id) { selectedDatabaseId = Number(match.id); break; }
          } catch (error) {
            failures.push(`Database API: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        for (let offset = 0; !selectedDatabaseId && offset < databaseCandidates.length; offset += 10) {
          const batch = databaseCandidates.slice(offset, offset + 10);
          const probeResults = await Promise.all(batch.map(async databaseId => {
            try {
              const probeResponse = await fetch(`${baseUrl}/api/v1/sqllab/execute/`, {
                method: 'POST', credentials: 'include', referrer: sqlLabUrl, referrerPolicy: 'strict-origin-when-cross-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf },
                body: JSON.stringify({ database_id: databaseId, sql: 'SELECT 1 FROM glue_catalog.motor_proposal_3.proposal LIMIT 1', runAsync: false, select_as_cta: false, tmp_table_name: '', client_id: crypto.randomUUID() }),
              });
              if (!probeResponse.ok) return null;
              const payload = await probeResponse.json();
              return payload.errors?.length ? null : databaseId;
            } catch { return null; }
          }));
          const match = probeResults.find(Boolean);
          if (match) selectedDatabaseId = Number(match);
          else failures.push(`No StarRocks match in IDs ${batch[0]}-${batch.at(-1)}`);
        }
        if (!selectedDatabaseId) return { error: `StarRocks database was not found through the Superset API or IDs 1-200. ${failures.at(-1) || ''}` };
        const queryResponse = await fetch(`${baseUrl}/api/v1/sqllab/execute/`, {
          method: 'POST', credentials: 'include', referrer: sqlLabUrl, referrerPolicy: 'strict-origin-when-cross-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf },
          body: JSON.stringify({ database_id: selectedDatabaseId, sql: query, runAsync: false, select_as_cta: false, tmp_table_name: '', client_id: crypto.randomUUID() }),
        });
        if (queryResponse.status === 401 || queryResponse.status === 403) return { error: 'SUPERSET_AUTH_REQUIRED' };
        const responseText = await queryResponse.text();
        if (!queryResponse.ok) return { error: `Query failed (${queryResponse.status}): ${responseText.slice(-3000)}` };
        const payload = JSON.parse(responseText);
        if (payload.errors?.length) return { error: String(payload.errors[0].message || 'Superset query failed').slice(-3000) };
        return { data: payload.data || payload.result?.data || [], databaseId: selectedDatabaseId };
      } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    },
  });
  const result = results[0]?.result;
  if (!result) throw new Error('Superset tab did not return a result');
  if (result.error) throw new Error(result.error);
  if (result.databaseId) {
    resolvedDatabaseId = result.databaseId;
    await chrome.storage.local.set({ supersetDatabaseId: result.databaseId });
  }
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
