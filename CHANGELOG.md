# Changelog

All notable changes to `scrapeunblocker-mcp` are documented here.

## 0.8.1

- Skyscanner flights, hotels and car hire plugins: every input now has a
  description in `list_plugins` / `run_plugin` (origin and destination,
  entity IDs, dates, passengers, `max_polls`, `max_results` and the rest).
  Tool names and inputs are unchanged.

## 0.8.0

- 16 new site plugins in `list_plugins` / `run_plugin`: `google_hotels`,
  `google_hotels_property`, `google_news`, `google_ads_transparency` and
  `google_ads_transparency_advertisers` (Google), `shopee_search`,
  `shopee_product`, `taobao_search`, `taobao_product`, `smyths_inventory`,
  `smyths_details`, `smyths_search`, `smyths_category`, `wish_search` and
  `wish_product` (E-commerce), and `upwork_jobs` (Jobs). 124 plugins in all.
- `google_shopping`: its description lists the `currencyCode` and Google
  product ids (`productId`, `catalogId`, `offerId`) the results now carry.
- No tool names or inputs changed.

## 0.7.0

- `fetch_markdown` and `search_and_read` get the Markdown from the API
  (`/getPageSource` with `markdown=true` and `main_content_only`) instead of
  converting HTML here. The API converts the page as served, so text split
  across inline tags stays whole: a price `$<span>19</span><span>.99</span>`
  reads `$19.99`, where converting the API's prettified HTML gave `$ 19 .99`.
  Tool names, inputs and annotations are unchanged.
- The page header is now just `URL: ...`; the page's own heading opens the
  Markdown, since the API sends no page title.
- `turndown`, `turndown-plugin-gfm` and `linkedom` are no longer dependencies.

## 0.6.0

- Browser `steps` moved from `fetch_html` to a new tool, `browse_page`.
  Steps click, type and submit on the target website, so the tool that runs
  them is annotated as not read-only (`readOnlyHint: false`,
  `destructiveHint: true`); `fetch_html` and every other tool stay read-only.
  Clients that called `fetch_html` with `steps` call `browse_page` instead.

## 0.5.0

- New `fetch_markdown` tool: reads a page in a real browser and returns clean
  Markdown (main content, absolute links, no scripts, styles, navigation or
  footer; tables as GFM tables). Usually 2-25% the size of `fetch_html`'s HTML.
  `main_content_only: false` keeps the whole page.
- New `search_and_read` tool: a Google search plus its top 1-5 result pages as
  Markdown in one call, with Google's AI Overview when there is one and the
  other results as title, URL and snippet. Billed as one search plus one
  request per page read.
- The core tools (`fetch_html`, `list_elements`, `fetch_parsed`,
  `google_search`) now carry read-only tool annotations, as the plugin tools do.

## 0.4.0

- The 15 most-used site plugins are now tools of their own: `amazon_search`,
  `amazon_product`, `amazon_reviews`, `walmart_search`, `ebay_search`,
  `google_shopping`, `google_local`, `maps_place_details`, `google_images`,
  `youtube_search`, `youtube_transcript`, `zillow_search`, `indeed_jobs`,
  `trustpilot_reviews`, `booking_hotels`. Their parameters are in the tool
  schema, so a model calls them in one step. Every plugin, these included,
  still runs through `list_plugins` / `run_plugin`.

## 0.3.5

- Dependencies: `@modelcontextprotocol/sdk` 1.32.1 (GHSA-6qxp-vccf-f47h, fixed in
  1.31.0) and patched transitive `proxy-addr`, `fast-uri`, `hono`, `ip-address`
  and `qs`; `npm audit` is clean. No behaviour change.

## 0.3.4

- Plugin catalog follows SDK 0.12.0: `google_images` takes `time_range` (hour,
  day, week, month or year) or `date_from` / `date_to` (YYYY-MM-DD) to return
  only the images Google found in that period.

## 0.3.3

- Plugin catalog: the Temu plugins are no longer listed.

## 0.3.2

- Plugin catalog follows SDK 0.11.0: the YouTube comments, Telegram and Quora
  plugins are no longer listed.

## 0.3.1

- Plugin catalog: `tiktok_shop_search` keyword optional, `aldi_au_specials` takes
  `category` (a Special Buys drop date), `capterra_search` without `page`,
  `app_store_reviews` without `lang`.

## 0.3.0

- **Site plugins.** Two new tools: `list_plugins` lists ScrapeUnblocker's
  ready-made scrapers for specific sites (100+: e-commerce, groceries, travel,
  Google Trends / Shopping / Maps, search engines, real estate, vehicles,
  jobs, reviews, apps, YouTube, Spotify, SEO tools) with their parameters,
  and `run_plugin` runs one and returns its JSON. Two tools over a catalog
  rather than a tool per plugin, so the tool list stays small. Unknown or
  missing parameters come back as a clear message with the plugin's docs.
- Needs `scrapeunblocker` 0.10.0.

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
