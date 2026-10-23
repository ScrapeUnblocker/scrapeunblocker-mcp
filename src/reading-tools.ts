/**
 * Tools that read pages as Markdown: `fetch_markdown` (one page) and
 * `search_and_read` (a Google search plus its top results, in one call).
 *
 * The API returns the Markdown (`/getPageSource` with `markdown=true`). It
 * converts the page as served; a conversion here could only start from the
 * prettified HTML the API returns, whose added whitespace splits inline runs
 * (a price `$<span>19</span><span>.99</span>` read "$ 19 .99").
 *
 * This file is identical in scrapeunblocker-mcp (src/reading-tools.ts) and
 * scrapeunblocker-mcp-remote (api/_lib/readingTools.ts); change both together.
 * Each server passes in how it calls the API, so the file carries no auth or
 * transport.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** A page read alone; MCP clients cut tool results around this size anyway. */
const PAGE_MAX_CHARS = 100_000;
/** Per page in search_and_read, so five pages still fit in one result. */
const SEARCH_PAGE_MAX_CHARS = 15_000;
const SEARCH_DEFAULT_RESULTS = 3;
const SEARCH_MAX_RESULTS = 5;
/** One slow page must not hold up the others past the function limit. */
const SEARCH_PAGE_DEADLINE_MS = 120_000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** `/getPageSource` query params; undefined ones are left out of the request. */
export type PageSourceParams = Record<string, string | number | boolean | undefined>;

interface ReadOptions {
  /** `main_content_only`: drop navigation, site header, footer and sidebars. */
  mainContentOnly: boolean;
  proxyCountry?: string;
  method?: "css" | "js";
  value?: string;
  timeSleep?: number;
}

export interface ReadingToolsOptions {
  /**
   * POST `/getPageSource` with `params` and return the body; throws when the
   * call fails. Only reads go through it, so retrying is safe.
   */
  getPageSource: (params: PageSourceParams) => Promise<string>;
  /** The `/serpApi` response for `keyword`. */
  serp: (keyword: string, options: { proxyCountry?: string }) => Promise<unknown>;
  /** The tool result for a failed `getPageSource` (e.g. the target's own 404). */
  fetchError: (url: string, err: unknown) => ToolResult;
  errorText: (err: unknown) => string;
  /** A result to answer with instead of calling the API (e.g. no account), or null. */
  blocked?: () => ToolResult | null;
}

interface OrganicResult {
  title: string;
  url: string;
  description: string;
}

function text(body: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: body }], isError } : { content: [{ type: "text", text: body }] };
}

/** The `/getPageSource` query that returns `url` as Markdown. */
function markdownParams(url: string, options: ReadOptions): PageSourceParams {
  return {
    url,
    markdown: true,
    main_content_only: options.mainContentOnly,
    proxy_country: options.proxyCountry,
    method: options.method,
    value: options.value,
    time_sleep: options.timeSleep,
  };
}

/** Cut `text` to `max` characters, saying so, so the agent knows it is partial. */
function capText(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut at ${max} of ${text.length} characters. ${hint}]`;
}

function pageText(url: string, markdown: string, max: number): string {
  return capText(`URL: ${url}\n\n${markdown.trim()}`, max, "Use fetch_html for the whole page.");
}

function organicResults(serp: unknown): OrganicResult[] {
  const organic = (serp as { organic?: unknown })?.organic;
  if (!Array.isArray(organic)) return [];
  const seen = new Set<string>();
  const out: OrganicResult[] = [];
  for (const item of organic as Record<string, unknown>[]) {
    const url = typeof item?.url === "string" ? item.url : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: typeof item.title === "string" ? item.title : url,
      url,
      description: typeof item.description === "string" ? item.description : "",
    });
  }
  return out;
}

function aiOverview(serp: unknown): string | null {
  const overview = (serp as { aiOverview?: { text?: unknown; sources?: unknown } | null })?.aiOverview;
  if (!overview || typeof overview.text !== "string" || !overview.text.trim()) return null;
  const sources = Array.isArray(overview.sources) ? overview.sources.filter((s) => typeof s === "string") : [];
  return sources.length ? `${overview.text.trim()}\n\nSources: ${sources.join(", ")}` : overview.text.trim();
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const proxyCountry = z
  .string()
  .length(2)
  .optional()
  .describe("Optional ISO country code to route through, e.g. 'US'.");

export function registerReadingTools(server: McpServer, options: ReadingToolsOptions): void {
  const annotations = { readOnlyHint: true, openWorldHint: true, destructiveHint: false };

  server.registerTool(
    "fetch_markdown",
    {
      title: "Fetch page as Markdown",
      annotations: { title: "Fetch page as Markdown", ...annotations },
      description:
        "Fetch a web page in a real browser through the ScrapeUnblocker API " +
        "(https://docs.scrapeunblocker.com) and return it as clean Markdown: the main " +
        "content with absolute links, without scripts, styles, navigation or footer. Use it " +
        "to read, quote or summarise a page; it is usually 2-25% the size of the HTML. Works " +
        "on JavaScript-rendered pages and on pages that refuse ordinary fetches (403/429, " +
        "captcha). Use fetch_html instead when you need the markup, selectors or browser " +
        "steps. Billed as one request.",
      inputSchema: {
        url: z.string().url().describe("The absolute URL to read (http/https)."),
        proxy_country: proxyCountry,
        wait_method: z
          .enum(["css", "js"])
          .optional()
          .describe("Optional render-wait: 'css' selector or 'js' expression."),
        wait_value: z.string().optional().describe("The selector/expression paired with wait_method."),
        sleep_seconds: z.number().positive().optional().describe("Extra seconds to wait after load."),
        main_content_only: z
          .boolean()
          .optional()
          .describe("Drop navigation, page header, footer and sidebars (default true). False keeps the whole page."),
      },
    },
    async (args) => {
      const blocked = options.blocked?.();
      if (blocked) return blocked;
      try {
        const markdown = await options.getPageSource(
          markdownParams(args.url, {
            mainContentOnly: args.main_content_only ?? true,
            proxyCountry: args.proxy_country,
            method: args.wait_method,
            value: args.wait_value,
            timeSleep: args.sleep_seconds,
          }),
        );
        return text(pageText(args.url, markdown, PAGE_MAX_CHARS));
      } catch (err) {
        return options.fetchError(args.url, err);
      }
    },
  );

  server.registerTool(
    "search_and_read",
    {
      title: "Search Google and read the top results",
      annotations: { title: "Search Google and read the top results", ...annotations },
      description:
        "Search Google through the ScrapeUnblocker API (https://docs.scrapeunblocker.com) and " +
        "read the top results in one call: returns Google's AI Overview when there is one, " +
        "each of the first `results` pages (default 3, max 5) as Markdown, and the other " +
        "organic results as title, URL and snippet. Use it to answer a question from the " +
        "live web. Billed as one request for the search plus one per page read.",
      inputSchema: {
        keyword: z.string().min(1).describe("The search query."),
        proxy_country: z
          .string()
          .length(2)
          .optional()
          .describe("Optional ISO country code to search from and read the pages through, e.g. 'US'."),
        results: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_RESULTS)
          .optional()
          .describe(`How many top results to read (default ${SEARCH_DEFAULT_RESULTS}, max ${SEARCH_MAX_RESULTS}).`),
      },
    },
    async (args) => {
      const blocked = options.blocked?.();
      if (blocked) return blocked;
      let serp: unknown;
      try {
        serp = await options.serp(args.keyword, { proxyCountry: args.proxy_country });
      } catch (err) {
        return text(options.errorText(err), true);
      }

      const organic = organicResults(serp);
      const overview = aiOverview(serp);
      if (!organic.length && !overview) {
        return text(`Google returned no organic results for "${args.keyword}". The search was billed as one request.`);
      }

      const toRead = organic.slice(0, args.results ?? SEARCH_DEFAULT_RESULTS);
      const pages = await Promise.allSettled(
        toRead.map((r) =>
          withDeadline(
            options.getPageSource(markdownParams(r.url, { mainContentOnly: true, proxyCountry: args.proxy_country })),
            SEARCH_PAGE_DEADLINE_MS,
          ),
        ),
      );

      const parts = [
        `Google results for "${args.keyword}": ${toRead.length} read below. Billed as one ` +
          `search plus one request per page read.`,
      ];
      if (overview) parts.push(`## Google AI Overview\n\n${overview}`);
      toRead.forEach((r, i) => {
        const page = pages[i];
        const body =
          page.status === "fulfilled"
            ? pageText(r.url, page.value, SEARCH_PAGE_MAX_CHARS)
            : `URL: ${r.url}\n\nCould not read this page: ${options.errorText(page.reason)}\nSnippet: ${r.description}`;
        parts.push(`## ${i + 1}. ${r.title}\n\n${body}`);
      });
      const rest = organic.slice(toRead.length);
      if (rest.length) {
        parts.push(
          "## Other results\n\n" + rest.map((r) => `- [${r.title}](${r.url}): ${r.description}`).join("\n"),
        );
      }
      return text(parts.join("\n\n"));
    },
  );
}
