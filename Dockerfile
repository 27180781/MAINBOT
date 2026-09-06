# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    MCP_AUTH_DIR=/app/.mcp-auth \
    MCP_CONFIG_PATH=/app/config/mcp-servers.json \
    INSTRUCTIONS_PATH=/app/config/instructions.md
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
# Persistent state: settings, rules, usage log and MCP OAuth tokens.
# Mount /app/data and /app/.mcp-auth as volumes (CapRover: "Persistent Directories").
RUN mkdir -p /app/data /app/.mcp-auth
VOLUME ["/app/data", "/app/.mcp-auth"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
