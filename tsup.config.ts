import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  // The entry is an executable MCP server started over stdio, so it needs a
  // shebang. tsup also marks the output file executable for us.
  banner: { js: "#!/usr/bin/env node" },
  // Ship a lean package: bundle nothing that npm already installs as a dep.
  // Keeping deps external means npx resolves them from node_modules.
  external: ["@modelcontextprotocol/sdk", "scrapeunblocker", "zod"],
});
