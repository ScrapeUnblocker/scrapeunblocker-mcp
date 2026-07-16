# Changelog

All notable changes to `scrapeunblocker-mcp` are documented here.

## 0.1.2

- Use the DNS-verified `com.scrapeunblocker/*` namespace for the official MCP
  registry. No functional changes to the tools.

## 0.1.1

- Add `mcpName` and a `server.json` manifest so the package can be listed in the
  official MCP registry. No functional changes to the tools.

## 0.1.0

- Initial release.
- MCP server (stdio) exposing three tools backed by the ScrapeUnblocker API:
  - `fetch_html` - fully rendered HTML of any URL, anti-bot bypassed.
  - `fetch_parsed` - AI-parsed structured JSON for a page.
  - `google_search` - Google organic results as JSON.
- Per-user API key via the `SCRAPEUNBLOCKER_KEY` environment variable
  (`SCRAPEUNBLOCKER_API_KEY` also accepted).
