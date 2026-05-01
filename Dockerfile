# syntax=docker/dockerfile:1.7

# ---- Stage 1: build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (including dev) using the lockfile when present.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps so we can copy a slim node_modules into the runtime image.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    UPLOAD_POST_MCP_PORT=8080

WORKDIR /app

# Copy only what's needed at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json README.md LICENSE ./
COPY examples ./examples

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8080

# wget is in busybox on alpine, used as the healthcheck client.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${UPLOAD_POST_MCP_PORT}/healthz" >/dev/null || exit 1

# Streamable HTTP mode is the only sensible deployment in a container.
CMD ["node", "dist/index.js", "--http"]
