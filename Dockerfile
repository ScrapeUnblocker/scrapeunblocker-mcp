# Build and run the ScrapeUnblocker stdio MCP server in a container so evaluators
# (e.g. Glama) can start it and perform MCP introspection (initialize + tools/list)
# with no credentials. A real SCRAPEUNBLOCKER_KEY is only needed when a tool is
# actually invoked - the server starts and lists its tools without one.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# stdio MCP server: reads JSON-RPC from stdin, writes to stdout.
ENTRYPOINT ["node", "dist/index.js"]
