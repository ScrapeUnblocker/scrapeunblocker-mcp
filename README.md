# ScrapeUnblocker MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude (and any other MCP client) fetch **any web page's HTML** through the
[ScrapeUnblocker](https://scrapeunblocker.com) scraping API, bypassing anti-bot
protection (Cloudflare, DataDome, PerimeterX, Akamai, Shape).

You bring your **own** API key. Nothing is shared or proxied through us.

## Tools

| Tool | What it does |
|------|--------------|
| `fetch_html` | Fetch the fully rendered HTML of a URL. |
| `fetch_parsed` | Fetch a page and return AI-parsed structured JSON. |
| `google_search` | Run a Google search and return organic results as JSON. |

## Get an API key

Sign up and grab your key at **https://app.scrapeunblocker.com**. The server
reads it from the `SCRAPEUNBLOCKER_KEY` environment variable.

## Install

### Claude Code

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
