// fetch_markdown and search_and_read end to end: the built server
// (dist/index.js) runs over stdio, as an MCP client starts it, against a local
// stand-in for the ScrapeUnblocker API that records every request.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAGES = {
  "https://shop.example/item": "# Item\n\nPrice: $19.99",
  "https://shop.example/long": "x".repeat(150_000),
};
const SERP = {
  organic: [
    { title: "Item", url: "https://shop.example/item", description: "first" },
    { title: "Gone", url: "https://shop.example/gone", description: "second" },
    { title: "Other", url: "https://other.example/", description: "third" },
  ],
  aiOverview: { text: "Items cost $19.99.", sources: ["https://shop.example/item"] },
};

let requests = [];
let busyAnswers = 0;
let api;
let client;

function answer(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(url.searchParams);
  requests.push({ method: req.method, path: url.pathname, query, key: req.headers["x-scrapeunblocker-key"] });
  if (url.pathname === "/serpApi") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(SERP));
  } else if (busyAnswers > 0) {
    busyAnswers -= 1;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("busy");
  } else if (PAGES[query.url]) {
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(PAGES[query.url]);
  } else {
    res.writeHead(404, { "content-type": "text/markdown; charset=utf-8", "x-origin-status": "404" });
    res.end("# Page not found");
  }
}

function pageRequests() {
  return requests.filter((r) => r.path === "/getPageSource");
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((c) => c.text).join(""), isError: Boolean(result.isError) };
}

before(async () => {
  api = createServer(answer);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  client = new Client({ name: "reading-tools-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: {
        ...process.env,
        SCRAPEUNBLOCKER_KEY: "test-key",
        SCRAPEUNBLOCKER_BASE_URL: `http://127.0.0.1:${api.address().port}`,
      },
    }),
  );
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => api.close(resolve));
});

beforeEach(() => {
  requests = [];
  busyAnswers = 0;
});

test("fetch_markdown asks the API for Markdown, main content only by default", async () => {
  const result = await call("fetch_markdown", { url: "https://shop.example/item" });
  assert.deepEqual(pageRequests(), [
    {
      method: "POST",
      path: "/getPageSource",
      query: { url: "https://shop.example/item", markdown: "true", main_content_only: "true" },
      key: "test-key",
    },
  ]);
  assert.equal(result.isError, false);
  assert.equal(result.text, "URL: https://shop.example/item\n\n# Item\n\nPrice: $19.99");
});

test("fetch_markdown passes main_content_only and the render options", async () => {
  await call("fetch_markdown", {
    url: "https://shop.example/item",
    main_content_only: false,
    proxy_country: "DE",
    wait_method: "css",
    wait_value: "#price",
    sleep_seconds: 2,
  });
  assert.deepEqual(pageRequests()[0].query, {
    url: "https://shop.example/item",
    markdown: "true",
    main_content_only: "false",
    proxy_country: "DE",
    method: "css",
    value: "#price",
    time_sleep: "2",
  });
});

test("a target's own 404 is an answer about the page, not a tool error", async () => {
  const result = await call("fetch_markdown", { url: "https://shop.example/gone" });
  assert.equal(result.isError, false);
  assert.match(result.text, /^The target page does not exist: https:\/\/shop\.example\/gone answered HTTP 404/);
  assert.match(result.text, /# Page not found$/);
});

test("a busy answer is retried", async () => {
  busyAnswers = 1;
  const result = await call("fetch_markdown", { url: "https://shop.example/item" });
  assert.equal(pageRequests().length, 2);
  assert.equal(result.isError, false);
  assert.match(result.text, /Price: \$19\.99$/);
});

test("a long page is cut at the cap, saying so", async () => {
  const result = await call("fetch_markdown", { url: "https://shop.example/long" });
  assert.match(result.text, /\[Cut at 100000 of 150032 characters\. Use fetch_html for the whole page\.\]$/);
});

test("search_and_read reads the top results as Markdown", async () => {
  const result = await call("search_and_read", { keyword: "item price", results: 2 });
  const serp = requests.filter((r) => r.path === "/serpApi");
  assert.equal(serp.length, 1);
  assert.equal(serp[0].query.keyword, "item price");
  assert.deepEqual(
    pageRequests().map((r) => r.query).sort((a, b) => a.url.localeCompare(b.url)),
    [
      { url: "https://shop.example/gone", markdown: "true", main_content_only: "true" },
      { url: "https://shop.example/item", markdown: "true", main_content_only: "true" },
    ],
  );
  assert.equal(result.isError, false);
  assert.ok(result.text.startsWith('Google results for "item price": 2 read below. Billed as one search plus one request per page read.'));
  assert.ok(result.text.includes("## Google AI Overview\n\nItems cost $19.99.\n\nSources: https://shop.example/item"));
  assert.ok(result.text.includes("## 1. Item\n\nURL: https://shop.example/item\n\n# Item\n\nPrice: $19.99"));
  assert.ok(result.text.includes("## 2. Gone\n\nURL: https://shop.example/gone\n\nCould not read this page: Target page does not exist (HTTP 404)"));
  assert.ok(result.text.endsWith("## Other results\n\n- [Other](https://other.example/): third"));
});
