# actual-curator: plain Node service, configured by environment variables (see .env.example).

# better-sqlite3 (via @actual-app/api) compiles from source on install, so the toolchain lives
# in a builder stage only.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5007

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY config ./config
COPY openapi.yaml LICENSE ./

# Runs as root so a host- or Supervisor-mounted /data is writable without chown.
VOLUME /data
EXPOSE 5007
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||5007}/v1/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
