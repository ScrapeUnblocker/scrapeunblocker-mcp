# Changelog

All notable changes to `scrapeunblocker-mcp` are documented here.

## 0.2.3

- **An empty parse returns the page.** When `fetch_parsed` reaches a page
  that holds no structured data, the API now answers HTTP 200 with
  `data_extracted: false` and the rendered HTML (billed like `fetch_html`),
  instead of the 422 `no_data_extracted` handled in 0.2.2. The tool says
  nothing could be extracted and returns that HTML, so no second
  `fetch_html` call is needed.

## 0.2.2

- **An empty parse is reported as such.** When `fetch_parsed` reaches a page
  that holds no structured data, the API now answers HTTP 422
  `no_data_extracted` (not billed, no HTML). The tool returns a plain result
  saying nothing could be extracted, that the call was not billed, and to use
  `fetch_html` for the page itself - instead of a generic HTTP 422 error.

## 0.2.1

- **A missing target page is reported as such.** When the page you asked for
  does not exist (the website answers HTTP 404 or 410), `fetch_html`,
  `list_elements` and `fetch_parsed` now return a plain result that says so -
  the target's own answer, billed, and not worth retrying - followed by the
  target's page, instead of a generic API error. Works with both the current
  API (a 404/410 with `X-Origin-Status`) and the earlier one (a 200 carrying
  `X-Origin-Status`).

## 0.2.0

- **Browser steps.** `fetch_html` now accepts an optional `steps` array: ordered
  browser actions (`wait_for`, `wait_for_text`, `wait`, `click`, `type`,
  `select`, `press_key`, `scroll`) that run in a real browser after the page
  loads, before the HTML is captured. Lets an agent accept cookie banners, click
  tabs, fill and submit forms, or scroll to trigger lazy loading, then get the
  resulting HTML. Steps run once (not idempotent); a failed step is surfaced
  clearly with the failing step, reason and the page HTML at that moment.
- **New `list_elements` tool.** Returns a JSON list of a page's notable elements
  with a ready-to-use `selector` for each (plus tag, text, name, id, type,
  placeholder, aria_label, href, ...). Read-only. It is the discovery half of
  interactive scraping: list elements, then build `steps` against those
  selectors.

## 0.1.4

- README now points Claude Code users at the official
  [Claude Code plugin](https://github.com/ScrapeUnblocker/claude-code-plugin),
  which installs this same server, prompts for the API key and stores it in the
  OS keychain, and adds a `/scrape-url` command plus reference skills. The
  `claude mcp add` route is still documented below it. No functional changes to
  the tools.

## 0.1.3

- README and registry links to scrapeunblocker.com now carry UTM parameters
  for traffic attribution. No functional changes to the tools.

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
