# Voicebot Superset Bridge

This extension lets the Vercel-hosted dashboard query private Superset through Chrome. Queries use the user's existing Superset login and corporate network; only aggregate funnel counts are sent back to the dashboard and stored in Upstash Redis.

## Install

1. Connect Chrome to the corporate network/VPN and sign in to Superset.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this `chrome-extension` folder.
6. Reload the Voicebot dashboard and click **Sync from Superset**.

The extension only activates its bridge on the local dashboard and `voicebot-dashboard-v2*.vercel.app`, and only has network access to the Superset hostname.
