# Vercel deployment

The Superset integration uses MCP directly over Streamable HTTP and does not spawn local processes. The configured MCP endpoint must also be reachable from Vercel.

The default endpoint currently resolves to the private corporate address `100.64.1.15`. Vercel cannot route to that address. For hosted Superset sync, the company must provide a publicly reachable authenticated relay (or private-network connectivity) and set its URL as `SUPERSET_MCP_URL`. Local development on the corporate network continues to use the default endpoint.

Configure these environment variables in the Vercel project for Production, Preview, and Development as appropriate:

- `UPSTASH_REDIS_REST_URL` — required for hosted persistence.
- `UPSTASH_REDIS_REST_TOKEN` — required for hosted persistence.
- `SUPERSET_MCP_URL` — required on Vercel until the default MCP endpoint becomes publicly routable; set this to the company-managed public relay.
- `SUPERSET_DATABASE_ID` — optional override; otherwise the `Trino` connection is discovered through Superset.
- Existing Google/Gmail and Groq variables remain required for their respective dashboard features.

Do not set `SUPERSET_MCP_INSECURE_TLS` in Vercel. Normal TLS certificate verification remains enabled in hosted environments.

The sync route declares a five-minute maximum duration. The tested June 30 conversion-plus-CDR sync completed in under ten seconds.
