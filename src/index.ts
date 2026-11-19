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
import { APIError, ScrapeUnblockerClient, errorForStatus } from "scrapeunblocker";
import { registerPluginTools } from "./plugin-tools.js";
import { registerReadingTools, type PageSourceParams } from "./reading-tools.js";

const VERSION = "0.13.2";

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

/**
 * Read by the person who set the server up and by the AI agent calling the
 * tool, so it gives each a way to a key: the person signs up, the agent may buy
 * one on the agent storefront when its user agrees, and use it over REST at
 * once, because a restarted server is what picks up the env var.
 */
const MISSING_KEY_MESSAGE =
  "No ScrapeUnblocker API key found. Set the SCRAPEUNBLOCKER_KEY environment " +
  "variable to your own key and restart the MCP server. A person gets a key at " +
  "https://app.scrapeunblocker.com (sign up free, 500 requests, no card). An AI " +
  "agent can, with its user's OK, buy a key itself with no signup at " +
  "https://agents.scrapeunblocker.com and call the REST API with it right away " +
  "(https://www.scrapeunblocker.com/llms.txt) until the server is restarted with the key.";

function resolveBaseUrl(): string {
  return (process.env.SCRAPEUNBLOCKER_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

/**
 * Our User-Agent token plus `mcp-host/<app>`: the app this server runs in (VS Code,
 * Cursor, Claude...), from the clientInfo it sent at initialize, so the API can
 * count MCP calls per app. Reduced to [a-z0-9-], at most 32 characters.
 */
function userAgent(): string {
  const name = server.server.getClientVersion()?.name ?? "";
  const app = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return app ? `scrapeunblocker-mcp/${VERSION} mcp-host/${app}` : `scrapeunblocker-mcp/${VERSION}`;
}

function client(): ScrapeUnblockerClient {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  // Optional override, e.g. to point a staging key at the staging host. Left
  // unset it defaults to the production API inside the SDK.
  const baseUrl = process.env.SCRAPEUNBLOCKER_BASE_URL || undefined;
  return new ScrapeUnblockerClient({ apiKey, baseUrl, userAgent: userAgent() });
}

/** Normalise any thrown value into a readable string for the tool result. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const TARGET_GONE = new Set([404, 410]);

/**
 * The target's own "page does not exist" answer (404/410), or null.
 *
 * `/getPageSource` always exists, so a 404/410 from it is the target site's
 * answer, sent with `X-Origin-Status`. Older API versions returned that same
 * answer as a 200 carrying the header, so the header is checked first.
 */
function targetGoneStatus(status: number, originStatus?: string | null): number | null {
  const origin = Number(originStatus);
  if (TARGET_GONE.has(origin)) return origin;
  return TARGET_GONE.has(status) ? status : null;
}

/**
 * Tool text for a target that answered 404/410. It is a result, not a tool
 * failure: the page was fetched and the call billed, and a retry returns the
 * same answer - so the model must not read it as an API error to retry.
 */
function targetGoneText(url: string, code: number, page: string): string {
  const reason = code === 410 ? "Gone" : "Not Found";
  const head =
    `The target page does not exist: ${url} answered HTTP ${code} (${reason}). ` +
    "This is the website's own answer, not a block or an API failure. The call " +
    "was billed, and retrying returns the same result - check the URL instead.";
  return page.trim()
    ? `${head}\n\nThe target's own ${code} page follows:\n\n${page}`
    : `${head}\n\nThe target sent no page body.`;
}

/**
 * The rendered page when `parsed_data` found nothing to extract, or null.
 * The API still answers 200 (billed like fetch_html) with
 * `data_extracted: false` and the page in `html`.
 */
function noDataExtractedHtml(raw: Record<string, unknown> | undefined): string | null {
  if (!raw || raw.data_extracted !== false) return null;
  return typeof raw.html === "string" ? raw.html : "";
}

function noDataExtractedText(url: string, html: string): string {
  const head =
    `No structured data could be extracted from ${url}: the page loaded, but ` +
    "nothing on it matched a structured shape. The call was billed like fetch_html, " +
    "so the rendered page is returned instead.";
  return html.trim() ? `${head}\n\nThe rendered HTML follows:\n\n${html}` : head;
}

/**
 * Tool result for a thrown error: a target 404/410 is an answer about the
 * page, not a tool failure, so it is reported as such.
 */
function errorResult(url: string, err: unknown) {
  if (err instanceof APIError) {
    const gone = targetGoneStatus(err.statusCode);
    if (gone !== null) {
      return { content: [{ type: "text" as const, text: targetGoneText(url, gone, err.body ?? "") }] };
    }
  }
  return { content: [{ type: "text" as const, text: errorText(err) }], isError: true };
}

type QueryParams = Record<string, string | number | boolean | undefined | null>;

interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
  originStatus: string | null;
}

/** The `/getPageSource` URL for `params`, leaving out unset ones. */
function pageSourceUrl(params: QueryParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return `${resolveBaseUrl()}/getPageSource?${query.toString()}`;
}

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    [API_KEY_HEADER]: apiKey,
    "User-Agent": userAgent(),
    Accept: "*/*",
  };
}

/**
 * A thin, raw POST to `/getPageSource` for the capabilities whose answers the
 * tools read themselves: interactive browser `steps` (which return HTML but can
 * also fail with an HTTP 422 body we must read), `list_elements` (which
 * returns JSON) and `capture_xhr` (JSON, and the same 422 when a step fails).
 * We mirror the SDK's query building and auth header, but return
 * the raw response so the caller can decide how to interpret it and can read
 * the 422 body instead of it being swallowed by an error class.
 */
async function getPageSourceRaw(params: QueryParams): Promise<RawResponse> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  const response = await fetch(pageSourceUrl(params), {
    method: "POST",
    headers: requestHeaders(apiKey),
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    text,
    originStatus: response.headers.get("x-origin-status"),
  };
}

/** The SDK client's defaults, so a page read as Markdown gets fetch_html's patience. */
const READ_TIMEOUT_MS = 180_000;
const READ_RETRIES = 2;
/** Busy (429) and gateway (502-504) answers: a later attempt can succeed. */
const RETRYABLE = new Set([429, 502, 503, 504]);

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8_000)));
}

/**
 * POST `/getPageSource` for a read (fetch_markdown, search_and_read) and
 * return the body. Transport and errors follow the SDK client: busy and
 * gateway answers and dropped connections are retried, and a failed call
 * throws the SDK's typed error, so a target's own 404/410 reaches
 * `errorResult` as the APIError it handles.
 */
async function readPageSource(params: PageSourceParams): Promise<string> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  const url = pageSourceUrl(params);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders(apiKey),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`No answer from ScrapeUnblocker within ${READ_TIMEOUT_MS / 1000} s.`);
      }
      if (attempt >= READ_RETRIES) throw new Error(`Could not reach ScrapeUnblocker: ${errorText(err)}`);
      await backoff(attempt);
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < READ_RETRIES) {
      await response.body?.cancel();
      await backoff(attempt);
      continue;
    }
    const body = await response.text();
    if (!response.ok) throw errorForStatus(response.status, body, response.headers);
    return body;
  }
}

const server = new McpServer({
  name: "scrapeunblocker",
  version: VERSION,
});

// ---------------------------------------------------------------------------
// Shared schema for interactive browser steps (used by browse_page).
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
    annotations: { title: "Fetch page HTML", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    description:
      "Fetch the fully rendered HTML of any public web page through ScrapeUnblocker. " +
      "The page loads in a real browser, so JavaScript-rendered pages come back " +
      "complete. Use it when you need the page markup, or when a plain HTTP fetch " +
      "returns 403/429 or an empty page. " +
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
      return errorResult(args.url, err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: browse_page
// ---------------------------------------------------------------------------
// Separate from fetch_html because it acts on the target site (clicks, typing,
// form submits), so it cannot carry the read-only annotation.
server.registerTool(
  "browse_page",
  {
    title: "Interact with a page, then capture it",
    annotations: {
      title: "Interact with a page, then capture it",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Load a web page in a real browser through ScrapeUnblocker, run an ordered " +
      "list of browser actions on it (accept a cookie banner, click a tab, type " +
      "into a search box, choose an option, press a key, scroll to trigger lazy " +
      "loading, wait), then return the resulting HTML. Steps act on the website and " +
      "are NOT idempotent - they run once per call. If a step fails, the result says " +
      "which step failed, why, and includes the page HTML at that moment. Billed as " +
      "one request.",
    inputSchema: {
      url: z.string().url().describe("The absolute URL to open (http/https)."),
      steps: z
        .array(stepSchema)
        .min(1)
        .describe(
          "Ordered browser actions to run in a real browser after the page " +
            "loads, before the HTML is captured. Use `list_elements` first to " +
            "find selectors. Runs once (not idempotent).",
        ),
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
          "Optional render-wait before the steps run: 'css' waits for a selector, 'js' waits for a JS expression to be truthy.",
        ),
      wait_value: z
        .string()
        .optional()
        .describe("The CSS selector or JS expression paired with wait_method."),
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
        .describe("Extra seconds to wait after load."),
    },
  },
  async (args) => {
    try {
      // Raw call so we can return HTML on success and read the 422
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

      const gone = targetGoneStatus(res.status, res.originStatus);
      if (gone !== null) {
        return { content: [{ type: "text", text: targetGoneText(args.url, gone, res.text) }] };
      }

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
      return errorResult(args.url, err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: capture_xhr
// ---------------------------------------------------------------------------
// The page's own XHR/fetch responses (getPageSource `capture_xhr`). Not
// read-only for the same reason as browse_page: its optional steps act on the
// site.

/** Default cap on the text this tool returns, so one call cannot flood the context. */
const CAPTURE_MAX_CHARS = 60_000;

interface CapturedCall {
  url?: string;
  method?: string;
  status?: number;
  content_type?: string | null;
  body?: string | null;
  body_omitted?: string;
}

/** The captured calls as text: one header line each, then its body. */
function capturedCallsText(calls: CapturedCall[], maxChars: number): string {
  const parts = calls.map((c, i) => {
    const head =
      `[${i}] ${c.status ?? 0} ${c.method ?? "GET"} ${c.url ?? ""}` +
      (c.content_type ? ` (${c.content_type})` : "");
    const body =
      typeof c.body === "string" ? c.body : `(no body: ${c.body_omitted ?? "unavailable"})`;
    return `${head}\n${body}`;
  });
  const text = parts.join("\n\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Cut at ${maxChars} of ${text.length} characters. Raise max_chars or narrow capture_xhr.]`;
}

server.registerTool(
  "capture_xhr",
  {
    title: "Capture a page's own API calls (XHR/fetch)",
    annotations: {
      title: "Capture a page's own API calls (XHR/fetch)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Load a web page in a real browser through ScrapeUnblocker and return the JSON " +
      "its own API calls received: every XHR/fetch response whose URL contains " +
      "`capture_xhr` (a fragment such as '/api/search'), in order, with status and " +
      "body. Use it when a site renders from a JSON API that refuses direct requests " +
      "(the page signs each call): the page makes the call, so it succeeds, and the " +
      "JSON is cleaner than the HTML. Optional `steps` make the page fire the call " +
      "(a search, 'load more'); steps act on the website and run once. Up to 20 " +
      "responses; the page HTML is not returned. Billed as one request; " +
      "when the site refuses every matching call (403/429) the call fails and is free.",
    inputSchema: {
      url: z.string().url().describe("The absolute URL to open (http/https)."),
      capture_xhr: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "A fragment of the API URL the page calls, e.g. '/api/search'. Every XHR/fetch " +
            "response whose URL contains it is returned (plain substring, case-sensitive).",
        ),
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          "Optional browser actions that make the page fire the call, run after the " +
            "page loads. Use `list_elements` first to find selectors. Runs once.",
        ),
      proxy_country: z
        .string()
        .length(2)
        .optional()
        .describe(
          "Optional ISO 3166-1 alpha-2 country code to route through, e.g. 'US', 'GB', 'DE'.",
        ),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Cap on the returned text (default ${CAPTURE_MAX_CHARS}).`),
    },
  },
  async (args) => {
    try {
      const res = await getPageSourceRaw({
        url: args.url,
        capture_xhr: args.capture_xhr,
        proxy_country: args.proxy_country,
        steps: args.steps && args.steps.length ? JSON.stringify(args.steps) : undefined,
      });
      const maxChars = args.max_chars ?? CAPTURE_MAX_CHARS;

      const gone = targetGoneStatus(res.status, res.originStatus);
      if (gone !== null) {
        return { content: [{ type: "text", text: targetGoneText(args.url, gone, res.text) }] };
      }

      let payload: {
        xhr?: CapturedCall[];
        xhr_truncated?: boolean;
        proxy?: string | null;
        error?: string;
        step_index?: number;
        action?: string;
        reason?: string;
        selector?: string;
      } = {};
      try {
        payload = JSON.parse(res.text);
      } catch {
        // Not JSON: reported below with the raw body.
      }

      if (res.ok && Array.isArray(payload.xhr)) {
        const calls = payload.xhr;
        const header =
          `URL: ${args.url}\n` +
          `Captured ${calls.length} call(s) matching ${JSON.stringify(args.capture_xhr)}` +
          (payload.xhr_truncated ? " (more matched; only the first 20 are returned)" : "") +
          (payload.proxy ? `, served from ${payload.proxy.toUpperCase()}` : "") +
          ".";
        if (!calls.length) {
          return {
            content: [
              {
                type: "text",
                text:
                  `${header}\n\nNo XHR/fetch call matched. Check the fragment against the ` +
                  "page's network requests, or add steps that make the page fire the call.",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: `${header}\n\n${capturedCallsText(calls, maxChars)}` }],
        };
      }

      if (res.status === 422 && payload.error === "step_failed") {
        const calls = Array.isArray(payload.xhr) ? payload.xhr : [];
        const summary =
          "Browser step failed" +
          (typeof payload.step_index === "number" ? ` at index ${payload.step_index}` : "") +
          (payload.action ? ` (${payload.action})` : "") +
          (payload.selector ? ` on selector ${JSON.stringify(payload.selector)}` : "") +
          `: ${payload.reason ?? "unknown reason"}.\n\n` +
          "Fix the step (use list_elements to inspect the page) and retry. " +
          `Calls the page made before the step failed: ${calls.length}.` +
          (calls.length ? `\n\n${capturedCallsText(calls, maxChars)}` : "");
        return { content: [{ type: "text", text: summary }], isError: true };
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
      return errorResult(args.url, err);
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
    annotations: { title: "List page elements (selector discovery)", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    description:
      "Load a page through ScrapeUnblocker and return a JSON list of its notable " +
      "elements (links, inputs, buttons, selects, etc.) with a ready-to-use " +
      "`selector` for each, plus tag, text and useful attributes (name, id, " +
      "type, placeholder, aria_label, href, ...). Read-only and does not " +
      "interact with the page. Use it to find the selectors a page's buttons, " +
      "inputs and links answer to.",
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
      const gone = targetGoneStatus(res.status, res.originStatus);
      if (!res.ok && gone === null) {
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
      if (gone !== null) {
        return { content: [{ type: "text", text: targetGoneText(args.url, gone, out) }] };
      }
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return errorResult(args.url, err);
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
    annotations: { title: "Fetch AI-parsed page data", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    description:
      "Fetch a web page through ScrapeUnblocker and return AI-parsed structured " +
      "JSON instead of raw HTML (e.g. product details, article content). Best " +
      "for extracting fields from product, listing or article pages without " +
      "writing your own HTML parsing. If the page holds no structured data, the " +
      "result says so and returns the rendered HTML instead (billed like fetch_html).",
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
      const noDataHtml = noDataExtractedHtml(parsed.raw);
      if (noDataHtml !== null) {
        return { content: [{ type: "text", text: noDataExtractedText(args.url, noDataHtml) }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      };
    } catch (err) {
      return errorResult(args.url, err);
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
    annotations: { title: "Google search results", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    description:
      "Run a Google search through ScrapeUnblocker and return the results " +
      "page as structured JSON: organic results with their real URLs, " +
      "favicons, sitelinks and star ratings, ads, the AI Overview, People " +
      "also ask, related searches with their links, the knowledge panel, " +
      "top stories, videos, local and shopping results. Use this to discover " +
      "URLs before fetching them. Set `full_urls` when you need the exact " +
      "page URL of every result.",
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
      full_urls: z
        .boolean()
        .optional()
        .describe(
          "Wait until Google gives out every result's real URL. Set it when " +
            "you need the exact page URL of all results (e.g. to cite or open " +
            "them); leave it off for quick answers. Google releases a results " +
            "page's links a few at a time, the last ones up to about 40 seconds " +
            "after the search: without it a result whose link has not come yet " +
            "has the site's home page as its `url` (or a Google redirect link), " +
            "with it the call takes up to about 40 seconds longer. Billed the same.",
        ),
    },
  },
  async (args) => {
    try {
      // Through plugin() because serp() only sends the options it knows, and
      // full_urls is not among them. The request is otherwise what serp() sends.
      const results = await client().plugin("/serpApi", {
        keyword: args.keyword,
        proxy_country: args.proxy_country,
        pages_to_check: args.pages_to_check ?? 1,
        full_urls: args.full_urls ? true : undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tools: fetch_markdown, search_and_read
// ---------------------------------------------------------------------------
registerReadingTools(server, {
  getPageSource: readPageSource,
  serp: (keyword, options) => client().serp(keyword, options),
  fetchError: errorResult,
  errorText,
});

// ---------------------------------------------------------------------------
// Tools: list_plugins, run_plugin and one tool per featured plugin
// ---------------------------------------------------------------------------
registerPluginTools(server, {
  call: (path, params) => client().plugin(path, params),
  errorText,
});

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
