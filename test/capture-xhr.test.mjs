// capture_xhr end to end: the built server (dist/index.js) runs over stdio, as an
// MCP client starts it, against a local stand-in for the ScrapeUnblocker API.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CAPTURED = {
  html: "<html>" + "x".repeat(5000) + "</html>",
  xhr: [
    { url: "https://api.shop.example/v2/items?page=1", method: "GET", status: 200,
      content_type: "application/json", body: '{"items":[1,2]}' },
    { url: "https://api.shop.example/v2/items?page=2", method: "GET", status: 403,
      content_type: "text/plain", body: null, body_omitted: "binary" },
  ],
  xhr_truncated: false,
  proxy: "us",
};
const STEP_FAILED = {
  error: "step_failed", step_index: 1, action: "click", reason: "selector not found",
  selector: "#more", html: "<html/>", xhr: [CAPTURED.xhr[0]],
};

let requests = [];
let api;
let client;

function answer(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(url.searchParams);
  requests.push(query);
  if (query.url === "https://shop.example/fail") {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify(STEP_FAILED));
  } else if (query.url === "https://shop.example/none") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...CAPTURED, xhr: [] }));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CAPTURED));
  }
}

async function call(args) {
  const result = await client.callTool({ name: "capture_xhr", arguments: args });
  return { text: result.content.map((c) => c.text).join(""), isError: Boolean(result.isError) };
}

before(async () => {
  api = createServer(answer);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  client = new Client({ name: "capture-xhr-test", version: "1.0.0" });
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
});

test("capture_xhr sends the fragment and steps, and returns the calls without the HTML", async () => {
  const steps = [{ action: "click", selector: "#more" }];
  const result = await call({
    url: "https://shop.example/search",
    capture_xhr: "/v2/items",
    steps,
    proxy_country: "US",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].capture_xhr, "/v2/items");
  assert.equal(requests[0].proxy_country, "US");
  assert.deepEqual(JSON.parse(requests[0].steps), steps);
  assert.equal(result.isError, false);
  assert.match(result.text, /Captured 2 call\(s\) matching "\/v2\/items", served from US\./);
  assert.match(result.text, /\[0\] 200 GET https:\/\/api\.shop\.example\/v2\/items\?page=1 \(application\/json\)\n\{"items":\[1,2\]\}/);
  assert.match(result.text, /\[1\] 403 GET .*\n\(no body: binary\)/);
  assert.ok(!result.text.includes("xxxxx"), "the page HTML is not returned");
});

test("capture_xhr without steps sends none, and says when nothing matched", async () => {
  const result = await call({ url: "https://shop.example/none", capture_xhr: "/v2/items" });
  assert.equal(requests[0].steps, undefined);
  assert.equal(result.isError, false);
  assert.match(result.text, /No XHR\/fetch call matched/);
});

test("capture_xhr caps the text at max_chars", async () => {
  const result = await call({ url: "https://shop.example/search", capture_xhr: "/v2", max_chars: 40 });
  assert.match(result.text, /\[Cut at 40 of \d+ characters\./);
});

test("capture_xhr reports a failed step with the calls made before it", async () => {
  const result = await call({
    url: "https://shop.example/fail",
    capture_xhr: "/v2/items",
    steps: [{ action: "click", selector: "#more" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /Browser step failed at index 1 \(click\) on selector "#more": selector not found\./);
  assert.match(result.text, /Calls the page made before the step failed: 1\./);
  assert.match(result.text, /\[0\] 200 GET https:\/\/api\.shop\.example\/v2\/items\?page=1/);
});
