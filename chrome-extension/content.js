const allowed = location.hostname === '127.0.0.1'
  || location.hostname === 'localhost'
  || location.hostname.startsWith('voicebot-dashboard-v2');

if (allowed) {
  // Use long-lived port to avoid 5-second chrome.runtime.sendMessage timeout
  let port = null;
  const pendingQueries = new Map();

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'SUPERSET_QUERY' });
    port.onMessage.addListener((response) => {
      const handler = pendingQueries.get(response.id);
      if (handler) {
        pendingQueries.delete(response.id);
        handler(response);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // Reject all pending queries
      for (const [id, handler] of pendingQueries) {
        handler({ success: false, error: 'Extension disconnected' });
        pendingQueries.delete(id);
      }
    });
    return port;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.source !== 'voicebot-dashboard') return;
    if (!['PING', 'RUN_QUERY'].includes(message.type)) return;

    if (message.type === 'PING') {
      window.postMessage({ source: 'superset-bridge', id: message.id, success: true, data: { ready: true } }, '*');
      return;
    }

    // RUN_QUERY — use long-lived port with message ID for response matching
    try {
      const p = getPort();
      pendingQueries.set(message.id, (response) => {
        window.postMessage({
          source: 'superset-bridge',
          id: message.id,
          success: Boolean(response?.success),
          data: response?.data,
          error: response?.error
        }, '*');
      });
      p.postMessage({ type: 'RUN_QUERY', sql: message.sql, id: message.id });
    } catch (err) {
      window.postMessage({ source: 'superset-bridge', id: message.id, success: false, error: String(err) }, '*');
    }
  });
}
