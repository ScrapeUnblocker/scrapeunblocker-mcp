/**
 * ScrapeUnblocker MCP server.
 *
 * Exposes the ScrapeUnblocker scraping API to any MCP-capable client (Claude
 * Desktop, Claude Code, claude.ai) as a small set of tools. Each user supplies
 * their own API key through the `SCRAPEUNBLOCKER_KEY` environment variable, so
 * the server holds no shared secret.
 *
 * Transport: stdio (the client spawns this process and talks over stdin/stdout).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ScrapeUnblockerClient } from "scrapeunblocker";

const VERSION = "0.1.2";

/**
 * The API key is read per call (not at startup) so the server still starts and
 * hands back a clear, actionable error instead of failing to connect when the
 * key is missing. We accept two env var names for convenience.
 */
function resolveApiKey(): string | undefined {
  return (
    process.env.SCRAPEUNBLOCKER_KEY ??
    process.env.SCRAPEUNBLOCKER_API_KEY ??
    undefined
  );
}

const MISSING_KEY_MESSAGE =
  "No ScrapeUnblocker API key found. Set the SCRAPEUNBLOCKER_KEY environment " +
  "variable to your own key (get one at https://app.scrapeunblocker.com) and " +
  "restart the MCP server.";

function client(): ScrapeUnblockerClient {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  // Optional override, e.g. to point a staging key at the staging host. Left
  // unset it defaults to the production API inside the SDK.
  const baseUrl = process.env.SCRAPEUNBLOCKER_BASE_URL || undefined;
  return new ScrapeUnblockerClient({ apiKey, baseUrl });
}

/** Normalise any thrown value into a readable string for the tool result. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const server = new McpServer({
  name: "scrapeunblocker",
  version: VERSION,
});

// ---------------------------------------------------------------------------
// Tool: fetch_html
// ---------------------------------------------------------------------------
server.registerTool(
  "fetch_html",
  {
    title: "Fetch page HTML",
    description:
      "Fetch the fully rendered HTML of any web page through ScrapeUnblocker, " +
      "bypassing anti-bot protection (Cloudflare, DataDome, PerimeterX, Akamai, " +
      "Shape). Use this when a normal fetch is blocked (403/429, captcha, " +
      "'access denied') or when the page needs a real browser to render. " +
      "Returns the raw HTML as text.",
    inputSchema: {
      url: z.string().url().describe("The absolute URL to fetch (http/https)."),
      proxy_country: z
        .string()
        .length(2)
        .optional()
        .describe(
          "Optional ISO 3166-1 alpha-2 country code to route through, e.g. 'US', 'GB', 'DE'.",
        ),
      wait_method: z
        .enum(["css", "js"])
        .optional()
        .describe(
          "Optional render-wait strategy: 'css' waits for a selector, 'js' waits for a JS expression to be truthy.",
        ),
      wait_value: z
        .string()
        .optional()
        .describe(
          "The CSS selector or JS expression paired with wait_method (e.g. '#price' or 'document.readyState===\"complete\"').",
        ),
      method_timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap in seconds for the render-wait method."),
      sleep_seconds: z
        .number()
        .positive()
        .optional()
        .describe("Extra seconds to wait after load before capturing the HTML."),
    },
  },
  async (args) => {
    try {
      const html = await client().getPageSource(args.url, {
        proxyCountry: args.proxy_country,
        method: args.wait_method,
        value: args.wait_value,
        methodTimeout: args.method_timeout_seconds,
        timeSleep: args.sleep_seconds,
      });
      return { content: [{ type: "text", text: html }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: fetch_parsed
// ---------------------------------------------------------------------------
server.registerTool(
  "fetch_parsed",
  {
    title: "Fetch AI-parsed page data",
    description:
      "Fetch a web page through ScrapeUnblocker and return AI-parsed structured " +
      "JSON instead of raw HTML (e.g. product details, article content). Best " +
      "for extracting fields from product, listing or article pages without " +
      "writing your own HTML parsing.",
    inputSchema: {
      url: z.string().url().describe("The absolute URL to fetch and parse."),
      proxy_country: z
        .string()
        .length(2)
        .optional()
        .describe("Optional ISO country code to route through, e.g. 'US'."),
      rules_hint: z
        .string()
        .optional()
        .describe(
          "Optional natural-language hint about what to extract, to guide parsing.",
        ),
    },
  },
  async (args) => {
    try {
      const parsed = await client().getParsed(args.url, {
        proxyCountry: args.proxy_country,
        rulesHint: args.rules_hint,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: google_search
// ---------------------------------------------------------------------------
server.registerTool(
  "google_search",
  {
    title: "Google search results",
    description:
      "Run a Google search through ScrapeUnblocker and return the organic " +
      "results as structured JSON. Use this to discover URLs before fetching " +
      "them.",
    inputSchema: {
      keyword: z.string().min(1).describe("The search query."),
      proxy_country: z
        .string()
        .length(2)
        .optional()
        .describe("Optional ISO country code to search from, e.g. 'US'."),
      pages_to_check: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe("How many result pages to collect (default 1)."),
    },
  },
  async (args) => {
    try {
      const results = await client().serp(args.keyword, {
        proxyCountry: args.proxy_country,
        pagesToCheck: args.pages_to_check,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A friendly heads-up on stderr (stdout is reserved for the MCP protocol).
  if (!resolveApiKey()) {
    process.stderr.write(
      "[scrapeunblocker-mcp] Warning: " + MISSING_KEY_MESSAGE + "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[scrapeunblocker-mcp] Fatal: ${errorText(err)}\n`);
  process.exit(1);
});
