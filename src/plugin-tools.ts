/**
 * The plugin tools: `list_plugins` finds a ready-made scraper for a site and
 * its parameters, `run_plugin` runs it and returns its JSON.
 *
 * Two tools over a catalog rather than one tool per plugin: a hundred tool
 * definitions would fill the model's context before the user asked anything.
 * The catalog (./plugin-catalog.ts) is generated from the public OpenAPI spec;
 * this file is the same in scrapeunblocker-mcp and scrapeunblocker-mcp-remote.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES as ALL_CATEGORIES, PLUGINS, type PluginInfo, type PluginParam } from "./plugin-catalog.js";

/** Longest tool text returned; a bigger result is cut with a note. */
const MAX_OUTPUT_CHARS = 100_000;

const BY_NAME = new Map(PLUGINS.map((p) => [p.name, p]));
const NAMES = PLUGINS.map((p) => p.name) as [string, ...string[]];
const CATEGORIES = ALL_CATEGORIES as [string, ...string[]];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface PluginToolsOptions {
  /** POST a plugin endpoint with these query parameters; resolves to its JSON. */
  call(path: string, params: Record<string, string | number | boolean | Array<string | number>>): Promise<unknown>;
  /** The tool text for a thrown error. */
  errorText(err: unknown): string;
  /** A result to answer with instead of calling the API (e.g. no account), or null. */
  blocked?(): ToolResult | null;
  /** Extra MCP annotations for both tools. */
  annotations?: Record<string, unknown>;
}

const text = (t: string, isError = false): ToolResult =>
  isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };

function signature(p: PluginInfo): string {
  return `${p.name}(${p.params.map((q) => (q.required ? `${q.name}*` : q.name)).join(", ")})`;
}

function paramLine(q: PluginParam): string {
  const type = q.type === "array" ? `list of ${q.items ?? "string"}` : q.join ? `${q.type} or list` : q.type;
  const extras = [
    q.enum ? `one of: ${q.enum.join(", ")}` : "",
    q.default !== undefined ? `default: ${String(q.default)}` : "",
  ].filter(Boolean);
  const tail = extras.length ? ` (${extras.join("; ")})` : "";
  return `- ${q.name} (${type}${q.required ? ", required" : ""}) - ${q.description}${tail}`;
}

function details(p: PluginInfo): string {
  const fixed = Object.entries(p.fixed);
  return [
    `${p.name} - ${p.title}`,
    `Category: ${p.category}. Endpoint: POST ${p.path}` +
      (fixed.length ? ` (sets ${fixed.map(([k, v]) => `${k}=${v}`).join(", ")} itself)` : ""),
    "",
    p.description,
    "",
    "Parameters:",
    ...p.params.map(paramLine),
  ].join("\n");
}

function listing(plugins: PluginInfo[]): string {
  const lines: string[] = [];
  for (const category of CATEGORIES) {
    const group = plugins.filter((p) => p.category === category);
    if (!group.length) continue;
    lines.push(`## ${category}`);
    for (const p of group) lines.push(`- ${signature(p)} - ${p.title}`);
    lines.push("");
  }
  lines.push(
    "* = required. Call list_plugins with `name` for a plugin's full parameter docs, " +
      "then run_plugin with that name and `params`.",
  );
  return lines.join("\n");
}

type ParamValue = string | number | boolean | Array<string | number>;

/** Check `params` against the plugin and shape list values the way the API reads them. */
function prepare(p: PluginInfo, params: Record<string, ParamValue>): Record<string, ParamValue> | string {
  const known = new Map(p.params.map((q) => [q.name, q]));
  const unknown = Object.keys(params).filter((k) => !known.has(k));
  if (unknown.length) {
    const fixed = unknown.filter((k) => k in p.fixed);
    if (fixed.length) return `${p.name} sets ${fixed.join(", ")} itself - leave it out.`;
    return `${p.name} has no parameter ${unknown.join(", ")}. Its parameters: ${[...known.keys()].join(", ")}.`;
  }
  const missing = p.params.filter((q) => q.required && (params[q.name] === undefined || params[q.name] === ""));
  if (missing.length) return `${p.name} needs ${missing.map((q) => q.name).join(", ")}.`;
  const out: Record<string, ParamValue> = { ...p.fixed };
  for (const [key, value] of Object.entries(params)) {
    const q = known.get(key)!;
    if (q.join && Array.isArray(value)) out[key] = value.join(q.join);
    else if (q.type === "array" && !Array.isArray(value)) out[key] = [value as string | number];
    else out[key] = value;
  }
  return out;
}

export function registerPluginTools(server: McpServer, options: PluginToolsOptions): void {
  const annotations = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, ...options.annotations };

  server.registerTool(
    "list_plugins",
    {
      title: "List site plugins",
      annotations: { title: "List site plugins", ...annotations },
      description:
        "List ScrapeUnblocker's ready-made site plugins: scrapers for specific sites that " +
        "return clean structured JSON (Amazon, Walmart, Target, eBay, Zillow, Redfin, " +
        "Booking.com, Airbnb, Indeed, Glassdoor, Google Trends / Shopping / Maps, YouTube, " +
        "Spotify, App Store, Google Play, Trustpilot, Yelp, Ahrefs, Semrush and 100+ more). " +
        "Check here before scraping a known site with fetch_html - a plugin returns the data " +
        "already parsed. Without arguments it lists every plugin with its parameters " +
        "(* = required); `category` or `search` narrow the list; `name` returns one " +
        "plugin's full parameter docs. Free - it calls nothing.",
      inputSchema: {
        name: z.string().optional().describe("A plugin name, for its full parameter docs."),
        category: z.enum(CATEGORIES).optional().describe("Only plugins in this category."),
        search: z
          .string()
          .optional()
          .describe("Only plugins whose name or description mentions this, e.g. 'zillow' or 'reviews'."),
      },
    },
    async (args) => {
      if (args.name) {
        const plugin = BY_NAME.get(args.name.trim());
        if (plugin) return text(details(plugin));
        return text(`No plugin named ${args.name}. Call list_plugins without a name for the list.`, true);
      }
      const needle = args.search?.toLowerCase().trim();
      const found = PLUGINS.filter(
        (p) =>
          (!args.category || p.category === args.category) &&
          (!needle ||
            [p.name, p.title, p.category, p.description].some((s) => s.toLowerCase().includes(needle))),
      );
      if (!found.length) return text(`No plugin matches. Categories: ${CATEGORIES.join(", ")}.`);
      if (found.length <= 3 && needle) return text(found.map(details).join("\n\n---\n\n"));
      return text(listing(found));
    },
  );

  server.registerTool(
    "run_plugin",
    {
      title: "Run a site plugin",
      annotations: { title: "Run a site plugin", ...annotations },
      description:
        "Run one ScrapeUnblocker site plugin and return its JSON - e.g. a Target or Walmart " +
        "search, a Zillow listing search, Google Trends for some keywords, an app's App Store " +
        "reviews. Find the plugin and its parameters with list_plugins first. `params` uses " +
        "the parameter names list_plugins shows (snake_case); a list value is fine where a " +
        "parameter takes several. Each run is billed like an API request; listing plugins " +
        "bill one unit per result page they fetch, so keep max_results modest.",
      inputSchema: {
        name: z.enum(NAMES).describe("The plugin to run, as list_plugins names it."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("The plugin's parameters, e.g. {\"query\": \"coffee maker\", \"max_results\": 20}."),
      },
    },
    async (args) => {
      const blocked = options.blocked?.();
      if (blocked) return blocked;
      const plugin = BY_NAME.get(args.name)!;
      const params = prepare(plugin, args.params ?? {});
      if (typeof params === "string") return text(`${params}\n\n${details(plugin)}`, true);
      try {
        const result = await options.call(plugin.path, params);
        const body = JSON.stringify(result);
        if (body.length <= MAX_OUTPUT_CHARS) return text(body);
        return text(
          body.slice(0, MAX_OUTPUT_CHARS) +
            `\n\n[Cut at ${MAX_OUTPUT_CHARS} of ${body.length} characters - ask for fewer results ` +
            "(max_results) or a narrower filter to get the whole answer.]",
        );
      } catch (err) {
        return text(options.errorText(err), true);
      }
    },
  );
}
