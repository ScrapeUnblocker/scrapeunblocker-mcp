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

const VERSION = "0.2.0";

/** Default API host, matching the SDK. */
const DEFAULT_BASE_URL = "https://api.scrapeunblocker.com";
/** The header the API expects the key in. */
const API_KEY_HEADER = "x-scrapeunblocker-key";

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

function resolveBaseUrl(): string {
  return (process.env.SCRAPEUNBLOCKER_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

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

type QueryParams = Record<string, string | number | boolean | undefined | null>;

interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * A thin, raw POST to `/getPageSource` for the two capabilities the typed SDK
 * methods do not model: interactive browser `steps` (which return HTML but can
 * also fail with an HTTP 422 body we must read) and `list_elements` (which
 * returns JSON). We mirror the SDK's query building and auth header, but return
 * the raw response so the caller can decide how to interpret it and can read
 * the 422 body instead of it being swallowed by an error class.
 */
async function getPageSourceRaw(params: QueryParams): Promise<RawResponse> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const url = `${resolveBaseUrl()}/getPageSource?${query.toString()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      [API_KEY_HEADER]: apiKey,
      "User-Agent": `scrapeunblocker-mcp/${VERSION}`,
      Accept: "*/*",
    },
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}

const server = new McpServer({
  name: "scrapeunblocker",
  version: VERSION,
});

// ---------------------------------------------------------------------------
// Shared schema for interactive browser steps (used by fetch_html).
// ---------------------------------------------------------------------------

/**
 * How a selector should be interpreted. Defaults to CSS server-side when
 * omitted.
 */
const selectorTypeSchema = z
  .enum(["css", "xPath", "className", "tagName"])
  .describe("How `selector` is interpreted. Defaults to 'css'.");

const pressableKeySchema = z.enum([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * One browser action. The `action` field is the discriminator; each variant
 * carries only the fields that action uses. These run in a real browser, in
 * order, AFTER the page loads. Discover selectors first with the
 * `list_elements` tool, then build these against them.
 */
const stepSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("wait_for"),
      selector: z.string().describe("Selector to wait for (until present)."),
      selector_type: selectorTypeSchema.optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .describe("Wait until an element matching `selector` exists."),
  z
    .object({
      action: z.literal("wait_for_text"),
      value: z.string().describe("Text to wait for anywhere on the page."),
      timeout_ms: z.number().int().positive().optional(),
    })
    .describe("Wait until the given text appears on the page."),
  z
    .object({
      action: z.literal("wait"),
      value: z
        .number()
        .int()
        .nonnegative()
        .describe("Fixed pause in milliseconds."),
    })
    .describe("Pause for a fixed number of milliseconds."),
  z
    .object({
      action: z.literal("click"),
      selector: z.string().describe("Selector of the element to click."),
      selector_type: selectorTypeSchema.optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .describe("Click the element matching `selector`."),
  z
    .object({
      action: z.literal("type"),
      selector: z.string().describe("Selector of the field to type into."),
      selector_type: selectorTypeSchema.optional(),
      value: z.string().describe("Text to type (entered human-like)."),
      clear: z
        .boolean()
        .optional()
        .describe("Clear the field before typing."),
      timeout_ms: z.number().int().positive().optional(),
    })
    .describe("Type text into an input, character by character."),
  z
    .object({
      action: z.literal("select"),
      selector: z.string().describe("Selector of the <select> element."),
      selector_type: selectorTypeSchema.optional(),
      value: z.string().describe("The option value to select."),
      timeout_ms: z.number().int().positive().optional(),
    })
    .describe("Choose an option in a <select> dropdown by value."),
  z
    .object({
      action: z.literal("press_key"),
      value: pressableKeySchema.describe("The key to press."),
    })
    .describe("Press a single keyboard key."),
  z
    .object({
      action: z.literal("scroll"),
      value: z
        .union([z.literal("bottom"), z.number().int()])
        .describe("'bottom' to scroll to the end, or a pixel offset."),
    })
    .describe("Scroll the page to the bottom or by a pixel amount."),
]);

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
      "Returns the raw HTML as text.\n\n" +
      "For pages that need interaction (accept a cookie banner, click a tab, " +
      "type into a search box, scroll to trigger lazy loading) pass `steps`: an " +
      "ordered list of browser actions run in a real browser AFTER the page " +
      "loads, then the resulting HTML is returned. Workflow: first call the " +
      "`list_elements` tool to discover the real selectors on the page, then " +
      "build `steps` against them. Steps are NOT idempotent - they run once per " +
      "call. If a step fails, this tool returns which step failed, why, and the " +
      "page HTML at that moment so you can fix the selector and retry.",
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
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          "Optional ordered browser actions to run in a real browser after the " +
            "page loads, before the HTML is captured. Use `list_elements` first " +
            "to find selectors. Runs once (not idempotent).",
        ),
    },
  },
  async (args) => {
    try {
      // No steps: use the typed SDK path (with its retry logic).
      if (!args.steps || args.steps.length === 0) {
        const html = await client().getPageSource(args.url, {
          proxyCountry: args.proxy_country,
          method: args.wait_method,
          value: args.wait_value,
          methodTimeout: args.method_timeout_seconds,
          timeSleep: args.sleep_seconds,
        });
        return { content: [{ type: "text", text: html }] };
      }

      // Steps: raw call so we can return HTML on success and read the 422
      // step_failed body on failure.
      const res = await getPageSourceRaw({
        url: args.url,
        proxy_country: args.proxy_country,
        method: args.wait_method,
        value: args.wait_value,
        method_timeout: args.method_timeout_seconds,
        time_sleep: args.sleep_seconds,
        steps: JSON.stringify(args.steps),
      });

      if (res.ok) {
        return { content: [{ type: "text", text: res.text }] };
      }

      if (res.status === 422) {
        // Failed browser step: { error, step_index, action, reason, selector, html }
        let detail: {
          error?: string;
          step_index?: number;
          action?: string;
          reason?: string;
          selector?: string;
          html?: string;
        } = {};
        try {
          detail = JSON.parse(res.text);
        } catch {
          // Fall through with the raw body if it is not JSON.
        }
        if (detail.error === "step_failed") {
          const idx =
            typeof detail.step_index === "number" ? detail.step_index : undefined;
          const summary =
            `Browser step failed` +
            (idx !== undefined ? ` at index ${idx}` : "") +
            (detail.action ? ` (${detail.action})` : "") +
            (detail.selector ? ` on selector ${JSON.stringify(detail.selector)}` : "") +
            `: ${detail.reason ?? "unknown reason"}.\n\n` +
            "Fix the selector or step (use list_elements to inspect the page) " +
            "and retry. The page HTML at the point of failure follows:\n\n" +
            (detail.html ?? "");
          return { content: [{ type: "text", text: summary }], isError: true };
        }
        return {
          content: [{ type: "text", text: res.text }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `ScrapeUnblocker returned HTTP ${res.status}: ${res.text.slice(0, 500)}`,
          },
        ],
        isError: true,
      };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: list_elements
// ---------------------------------------------------------------------------
server.registerTool(
  "list_elements",
  {
    title: "List page elements (selector discovery)",
    description:
      "Load a page through ScrapeUnblocker and return a JSON list of its notable " +
      "elements (links, inputs, buttons, selects, etc.) with a ready-to-use " +
      "`selector` for each, plus tag, text and useful attributes (name, id, " +
      "type, placeholder, aria_label, href, ...). Read-only and does not " +
      "interact with the page. This is the discovery half of interactive " +
      "scraping: call `list_elements` to find the selectors you need, then pass " +
      "matching `steps` to `fetch_html` to click/type/select and capture the " +
      "resulting HTML.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("The absolute URL whose elements you want to list."),
      proxy_country: z
        .string()
        .length(2)
        .optional()
        .describe("Optional ISO country code to route through, e.g. 'US'."),
    },
  },
  async (args) => {
    try {
      const res = await getPageSourceRaw({
        url: args.url,
        list_elements: true,
        proxy_country: args.proxy_country,
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `ScrapeUnblocker returned HTTP ${res.status}: ${res.text.slice(0, 500)}`,
            },
          ],
          isError: true,
        };
      }
      // The API returns JSON already; pretty-print it if we can parse it.
      let out = res.text;
      try {
        out = JSON.stringify(JSON.parse(res.text), null, 2);
      } catch {
        // Not JSON for some reason - hand back the raw body.
      }
      return { content: [{ type: "text", text: out }] };
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
