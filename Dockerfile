# syntax=docker/dockerfile:1.7
# Base images are pinned by digest (@sha256): the tag is only a label.
# To update one: docker buildx imagetools inspect <tag> and paste the new digest.

# ---- Stage 1: build ----
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder

WORKDIR /app

# Install all deps (including dev) exactly as pinned in the lockfile.
# No fallback to `npm install`: without a lockfile the build must fail.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps so we can copy a slim node_modules into the runtime image.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS runtime

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
