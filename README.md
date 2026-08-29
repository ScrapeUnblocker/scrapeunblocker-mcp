# ScrapeUnblocker MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude (and any other MCP client) fetch **any web page's HTML** through the
[ScrapeUnblocker](https://scrapeunblocker.com?utm_source=mcp&utm_medium=integration&utm_campaign=mcp-server) scraping API, bypassing anti-bot
protection (Cloudflare, DataDome, PerimeterX, Akamai, Shape).

You bring your **own** API key. Nothing is shared or proxied through us.

## Tools

| Tool | What it does |
|------|--------------|
| `fetch_html` | Fetch the fully rendered HTML of a URL (optionally after running interactive browser `steps`). |
| `list_elements` | List a page's notable elements with a ready-to-use selector for each (selector discovery). |
| `fetch_parsed` | Fetch a page and return AI-parsed structured JSON. |
| `google_search` | Run a Google search and return organic results as JSON. |

### Browser steps (interact, then capture)

Some pages only reveal what you need after you interact with them - accept a
cookie banner, click a tab, type into a search box and submit, or scroll to
trigger lazy loading. Pass an optional `steps` array to `fetch_html` and those
actions run in a **real browser**, in order, after the page loads; the resulting
HTML is then returned.

Available actions:

| Action | Fields |
|--------|--------|
| `wait_for` | `selector`, `selector_type?` (`css`/`xPath`/`className`/`tagName`), `timeout_ms?` |
| `wait_for_text` | `value`, `timeout_ms?` |
| `wait` | `value` (ms) |
| `click` | `selector`, `selector_type?`, `timeout_ms?` |
| `type` | `selector`, `selector_type?`, `value`, `clear?`, `timeout_ms?` (typed human-like) |
| `select` | `selector`, `selector_type?`, `value`, `timeout_ms?` |
| `press_key` | `value` (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `Arrow*`, `Home`, `End`, `PageUp`, `PageDown`) |
| `scroll` | `value` (`"bottom"` or a pixel offset) |

Steps are **not idempotent** - they run once per call. If a step fails,
`fetch_html` returns which step failed, why, and the page HTML at that moment so
you can fix the selector and retry.

### List elements (discover selectors first)

`list_elements` loads a page and returns a JSON list of its notable elements
(links, inputs, buttons, selects, ...), each with a ready-to-use `selector` plus
`tag`, `text` and useful attributes (`name`, `id`, `type`, `placeholder`,
`aria_label`, `href`, ...):

```json
{ "url": "https://example.com", "count": 42, "elements": [ { "tag": "input", "selector": "#search", "type": "text", "placeholder": "Search", "aria_label": "Search" } ] }
```

The natural workflow is **discover, then act**: call `list_elements` to find the
selectors you need, then pass matching `steps` to `fetch_html` to click/type/
select and capture the resulting HTML.

## Get an API key

Sign up and grab your key at **[app.scrapeunblocker.com](https://app.scrapeunblocker.com?utm_source=mcp&utm_medium=integration&utm_campaign=mcp-server)**. The server
reads it from the `SCRAPEUNBLOCKER_KEY` environment variable.

## Install

### Claude Code

The easiest route is the official **plugin**, which installs this server for you,
prompts for your API key (stored in your OS keychain rather than an environment
variable), and adds a `/scrape-url` command plus reference skills:

```
/plugin marketplace add ScrapeUnblocker/claude-code-plugin
/plugin install scrapeunblocker@scrapeunblocker
```

See [ScrapeUnblocker/claude-code-plugin](https://github.com/ScrapeUnblocker/claude-code-plugin).

To add the bare server instead:

```bash
claude mcp add scrapeunblocker \
  --env SCRAPEUNBLOCKER_KEY=your_api_key_here \
  -- npx -y scrapeunblocker-mcp
```

### Claude Desktop

Add this to your `claude_desktop_config.json`
(Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "scrapeunblocker": {
      "command": "npx",
      "args": ["-y", "scrapeunblocker-mcp"],
      "env": {
        "SCRAPEUNBLOCKER_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop and the ScrapeUnblocker tools appear.

### Any other MCP client

Run the server over stdio:

```bash
SCRAPEUNBLOCKER_KEY=your_api_key_here npx -y scrapeunblocker-mcp
```

## Example prompts

- "Fetch the HTML of https://www.example-shop.com/product/123 and list the price."
- "This page keeps blocking me: <url>. Use fetch_html to get it."
- "List the elements on <url>, then use fetch_html steps to type 'laptop' into the search box, press Enter, wait for the results, and give me the HTML."
- "Search Google for 'best running shoes 2026' and give me the top 5 links."

## Development

```bash
npm install
npm run build      # bundles to dist/ with tsup
npm run typecheck
SCRAPEUNBLOCKER_KEY=... node dist/index.js   # run the server
```

## License

MIT
