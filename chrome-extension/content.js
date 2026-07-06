const allowed = location.hostname === '127.0.0.1'
  || location.hostname === 'localhost'
  || location.hostname.startsWith('voicebot-dashboard-v2');

if (allowed) {
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.source !== 'voicebot-dashboard') return;
    if (!['PING', 'RUN_QUERY'].includes(message.type)) return;
    if (message.type === 'PING') {
      window.postMessage({ source: 'superset-bridge', id: message.id, success: true, data: { ready: true } }, '*');
      return;
    }
    chrome.runtime.sendMessage({ type: message.type, sql: message.sql }, response => {
      const error = chrome.runtime.lastError?.message;
      window.postMessage({ source: 'superset-bridge', id: message.id, success: Boolean(response?.success) && !error, data: response?.data, error: error || response?.error }, '*');
    });
  });
}
