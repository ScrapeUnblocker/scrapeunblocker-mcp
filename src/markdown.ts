/**
 * Rendered HTML -> Markdown for agents.
 *
 * Raw HTML is mostly markup an agent pays for in tokens and never reads, so
 * `fetch_markdown` and `search_and_read` hand back Markdown instead. The page
 * is cleaned first (scripts, styles, embeds, form controls), links and images
 * are made absolute so the agent can follow them, and with `mainOnly` the
 * page's navigation, header, footer and sidebars are dropped.
 *
 * This file is identical in scrapeunblocker-mcp (src/markdown.ts) and
 * scrapeunblocker-mcp-remote (api/_lib/markdown.ts); change both together.
 */

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** Never content: removed before conversion in every mode. */
const ALWAYS_DROP = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
  "link", "meta", "head", "button", "input", "select", "textarea", "dialog",
  "[hidden]", '[aria-hidden="true"]',
].join(",");

/** Page chrome: removed when only the main content is wanted. */
const CHROME = ["nav", "footer", "aside", '[role="navigation"]', '[role="contentinfo"]', '[role="complementary"]'].join(",");

/**
 * A <main> smaller than this share of the page's text is a stub (some sites
 * wrap only a hero in it), so the whole body is used instead.
 */
const MAIN_MIN_SHARE = 0.3;

export interface MarkdownOptions {
  /** Drop navigation, page header, footer and sidebars. */
  mainOnly: boolean;
}

export interface MarkdownPage {
  title: string;
  markdown: string;
}

function textLength(el: { textContent: string | null } | null): number {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function converter(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.use(gfm);
  // Images carry an absolute URL only when they have alt text; decorative and
  // tracking images would just be noise.
  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as { getAttribute(name: string): string | null };
      const alt = (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
      const src = el.getAttribute("src") || "";
      return alt && /^https?:/i.test(src) ? `![${alt}](${src})` : "";
    },
  });
  // A cell holding paragraphs or lists would break the row onto several
  // lines; flatten it to one line and escape pipes so the grid survives.
  td.addRule("flatCells", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const cell = node as unknown as { parentNode: { childNodes: ArrayLike<unknown> } };
      const first = Array.prototype.indexOf.call(cell.parentNode.childNodes, cell) === 0;
      const text = content.replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();
      return `${first ? "| " : " "}${text} |`;
    },
  });
  return td;
}

type Doc = ReturnType<typeof parseHTML>["document"];

/**
 * Rebuild every table as a clean thead/tbody grid. The GFM rule converts only
 * tables whose first row is all <th> with no stray text nodes and leaves every
 * other table as raw HTML, which is most real pages (key/value spec tables).
 * One-row and one-column tables are layout, not data, so their cells become
 * plain blocks.
 * Inner tables go first, so an outer table sees them already converted.
 */
function normalizeTables(document: Doc): void {
  for (const table of [...document.querySelectorAll("table")].reverse()) {
    const rows = [...table.querySelectorAll("tr")]
      .filter((tr) => tr.closest("table") === table)
      .map((tr) => [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH"))
      .filter((cells) => cells.length > 0);
    if (rows.length === 0) {
      table.remove();
      continue;
    }
    if (rows.length === 1 || Math.max(...rows.map((cells) => cells.length)) === 1) {
      const blocks = document.createElement("div");
      for (const [cell] of rows) {
        const block = document.createElement("div");
        block.innerHTML = cell.innerHTML;
        blocks.appendChild(block);
      }
      table.replaceWith(blocks);
      continue;
    }
    const clean = document.createElement("table");
    rows.forEach((cells, i) => {
      const section = document.createElement(i === 0 ? "thead" : "tbody");
      const tr = document.createElement("tr");
      for (const cell of cells) {
        const out = document.createElement(i === 0 ? "th" : "td");
        out.innerHTML = cell.innerHTML.replace(/\s+/g, " ");
        tr.appendChild(out);
      }
      if (i === 0 || !clean.lastElementChild || clean.lastElementChild.tagName !== "TBODY") {
        section.appendChild(tr);
        clean.appendChild(section);
      } else {
        clean.lastElementChild.appendChild(tr);
      }
    });
    table.replaceWith(clean);
  }
}

/** Convert a rendered page to Markdown. `url` resolves relative links. */
export function htmlToMarkdown(html: string, url: string, options: MarkdownOptions): MarkdownPage {
  // Not markup (JSON, plain text): hand it back as it came.
  if (!/<[a-z!][\s\S]*>/i.test(html)) return { title: "", markdown: html.trim() };

  const { document } = parseHTML(html);
  const title = (document.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim();

  for (const el of document.querySelectorAll(ALWAYS_DROP)) el.remove();

  for (const a of document.querySelectorAll("a[href]")) {
    const href = absolute(a.getAttribute("href") || "", url);
    if (href) a.setAttribute("href", href);
    else a.removeAttribute("href");
  }
  for (const img of document.querySelectorAll("img")) {
    const src = absolute(img.getAttribute("src") || "", url);
    if (src) img.setAttribute("src", src);
    else img.removeAttribute("src");
  }

  const body = document.body ?? document.documentElement;
  let root = body;
  if (options.mainOnly) {
    const main = document.querySelector('main, [role="main"]');
    if (main && textLength(main) >= MAIN_MIN_SHARE * textLength(body)) {
      root = main as typeof body;
    } else {
      for (const el of document.querySelectorAll(CHROME)) el.remove();
      // A site header, not an article's own header.
      for (const header of document.querySelectorAll('header, [role="banner"]')) {
        if (!header.closest("article, main")) header.remove();
      }
    }
  }

  normalizeTables(document);

  let converted: string;
  try {
    converted = converter().turndown(root.innerHTML);
  } catch {
    // Markup turndown cannot handle: plain text beats no answer.
    converted = (root.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n");
  }
  const markdown = converted
    .replace(/\[\s*\]\([^)]*\)/g, "") // links with no visible text
    .replace(/^(\s*)([-*+]|\d+\.) {2,}/gm, "$1$2 ") // turndown pads list markers
    .replace(/(\)|\*\*|_) ([.,;:!?])/g, "$1$2") // pretty-printed HTML spaces inline ends
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

/** Cut `text` to `max` characters, saying so, so the agent knows it is partial. */
export function capText(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut at ${max} of ${text.length} characters. ${hint}]`;
}
