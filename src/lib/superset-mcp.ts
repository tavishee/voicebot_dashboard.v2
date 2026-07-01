import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = process.env.SUPERSET_MCP_URL || 'https://mcp-superset.platform.mypaytm.com/message';
const CONFIGURED_DATABASE_ID = Number(process.env.SUPERSET_DATABASE_ID || 0);

type AuthPayload = { error: string; auth_url: string; session_id?: string };
type McpState = { client?: Client; transport?: StreamableHTTPClientTransport; connecting?: Promise<Client>; databaseId?: number };
const root = globalThis as typeof globalThis & { __supersetMcp?: McpState };
const state: McpState = root.__supersetMcp || (root.__supersetMcp = {});

async function connect() {
  if (state.client) return state.client;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    if (!process.env.VERCEL && process.env.SUPERSET_MCP_INSECURE_TLS !== 'false') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const client = new Client({ name: 'voicebot-dashboard', version: '1.0.0' });
    await client.connect(transport);
    state.client = client;
    state.transport = transport;
    return client;
  })();

  try { return await state.connecting; }
  catch (error) {
    state.client = undefined;
    state.transport = undefined;
    throw error;
  } finally { state.connecting = undefined; }
}

function textPayload(result: any) {
  const text = result?.content?.find((part: any) => part.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function authPayload(result: any): AuthPayload | null {
  const payload = textPayload(result);
  return payload?.error === 'Authentication required' && payload?.auth_url ? payload : null;
}

export async function checkSupersetAuth() {
  const client = await connect();
  const tools = await client.listTools();
  const probe = tools.tools.find(tool => tool.name === 'superset_user_get_current')
    || tools.tools.find(tool => tool.name === 'superset_database_list');
  if (!probe) throw new Error('Superset MCP authentication probe is unavailable');
  const result = await client.callTool({ name: probe.name, arguments: {} });
  const auth = authPayload(result);
  return auth ? { authenticated: false as const, authUrl: auth.auth_url } : { authenticated: true as const };
}

function findRows(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    if (!value.length || value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      return value as Record<string, unknown>[];
    }
    for (const item of value) { const rows = findRows(item); if (rows) return rows; }
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['data', 'rows', 'result', 'records']) {
      if (key in object) { const rows = findRows(object[key]); if (rows) return rows; }
    }
  }
  return null;
}

async function getDatabaseId(client: Client) {
  if (CONFIGURED_DATABASE_ID > 0) return CONFIGURED_DATABASE_ID;
  const result: any = await client.callTool({ name: 'superset_database_list', arguments: {} });
  const auth = authPayload(result);
  if (auth) throw Object.assign(new Error('SUPERSET_AUTH_REQUIRED'), { authUrl: auth.auth_url });
  const databases = findRows(textPayload(result)) || [];
  const preferred = databases.find(db => {
    const label = String(db.database_name || db.name || '').toLowerCase();
    return label === 'trino';
  }) || databases.find(db => {
    const label = String(db.database_name || db.name || db.backend || '').toLowerCase();
    return label.includes('starrocks_glue_catalog');
  }) || databases.find(db => {
    const label = String(db.database_name || db.name || db.backend || '').toLowerCase();
    return label.includes('starrocks');
  });
  const id = Number(preferred?.id || preferred?.database_id);
  if (!id) {
    throw new Error(`Could not find the SQL database connection. Available: ${databases.map(db => db.database_name || db.name || db.id).join(', ')}`);
  }
  state.databaseId = id;
  return id;
}

export async function runSupersetQuery(query: string) {
  const client = await connect();
  const tools = await client.listTools();
  const queryTool = tools.tools.find(tool => tool.name === 'superset_sqllab_execute_query');
  if (!queryTool) throw new Error(`Superset MCP has no SQL query tool. Available: ${tools.tools.map(t => t.name).join(', ')}`);
  const databaseId = await getDatabaseId(client);

  const result: any = await client.callTool({
    name: queryTool.name,
    arguments: { database_id: databaseId, sql: query },
  });
  const auth = authPayload(result);
  if (auth) throw Object.assign(new Error('SUPERSET_AUTH_REQUIRED'), { authUrl: auth.auth_url });
  if (result.isError) throw new Error(textPayload(result) || 'Superset query failed');

  const structuredRows = findRows(result.structuredContent);
  if (structuredRows) return structuredRows;
  for (const part of result.content || []) {
    if (part.type !== 'text') continue;
    try { const rows = findRows(JSON.parse(part.text)); if (rows) return rows; } catch { /* continue */ }
    const start = part.text.indexOf('['), end = part.text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { const rows = findRows(JSON.parse(part.text.slice(start, end + 1))); if (rows) return rows; } catch { /* continue */ }
    }
  }
  const payload = textPayload(result);
  if (payload?.error) throw new Error(payload.details || payload.error);
  console.error('[superset-mcp] Unsupported query result:', JSON.stringify(result).slice(0, 8000));
  throw new Error('Superset returned an unsupported result format');
}
