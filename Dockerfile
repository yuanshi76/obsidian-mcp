# obsidian-mcp HTTP server image.
# Build:   docker build -t obsidian-mcp .
# Run:     see docker-compose.yml — the vault directory must be bind-mounted at /vault.

# ---- deps ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- production ----
FROM node:24-alpine AS production
WORKDIR /app
# Runtime needs the node binary only. Stripping the bundled package managers
# removes their vulnerable transitive deps (brace-expansion, ip-address,
# undici — flagged by Trivy as HIGH/CRITICAL in the base image), shrinks the
# attack surface, and cuts image size. HEALTHCHECK/CMD invoke node directly.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn-*
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser
# package.json must ship: src/constants.ts reads it at startup for the version.
COPY --from=build --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /app/dist ./dist
COPY --from=build --chown=appuser:appgroup /app/package.json ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js", "serve", "--http", "--host", "0.0.0.0", "--port", "3000", "--vault", "vault=/vault"]
