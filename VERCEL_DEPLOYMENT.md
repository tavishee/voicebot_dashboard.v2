# Vercel deployment

The Superset integration uses the MCP endpoint directly over Streamable HTTP, so it does not spawn local processes and is compatible with Vercel's Node.js runtime.

Configure these environment variables in the Vercel project for Production, Preview, and Development as appropriate:

- `UPSTASH_REDIS_REST_URL` — required for hosted persistence.
- `UPSTASH_REDIS_REST_TOKEN` — required for hosted persistence.
- `SUPERSET_MCP_URL` — optional; defaults to `https://mcp-superset.platform.mypaytm.com/message`.
- `SUPERSET_DATABASE_ID` — optional override; otherwise the `Trino` connection is discovered through Superset.
- Existing Google/Gmail and Groq variables remain required for their respective dashboard features.

Do not set `SUPERSET_MCP_INSECURE_TLS` in Vercel. Normal TLS certificate verification remains enabled in hosted environments.

The sync route declares a five-minute maximum duration. The tested June 30 conversion-plus-CDR sync completed in under ten seconds.
