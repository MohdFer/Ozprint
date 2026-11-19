# OzPrint v3.0 — Official Multi-Stage Linux Dockerfile
# Includes Node.js 20 LTS, Python 3.11 (pypdf, pdf2image, Pillow), CUPS 2.4+ client,
# Poppler-utils, and compiled better-sqlite3 WAL engine.

FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/tailwind.config.js apps/web/postcss.config.js apps/web/index.html ./apps/web/
COPY apps/agent/package.json apps/agent/tsconfig.json ./apps/agent/

RUN npm install

COPY apps/ ./apps/
COPY workers/ ./workers/

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime Stage
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    cups-client \
    cups-bsd \
    poppler-utils \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create least-privilege ozprint service account in lp group
RUN useradd --system --no-create-home --shell /usr/sbin/nologin --gid lp ozprint \
    && mkdir -p /var/lib/ozprint /app \
    && chown -R ozprint:lp /var/lib/ozprint \
    && chmod 0750 /var/lib/ozprint

WORKDIR /app

COPY workers/requirements.txt ./workers/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r workers/requirements.txt

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/agent/dist ./apps/agent/dist
COPY --from=builder /app/workers ./workers

RUN chown -R ozprint:lp /app

USER ozprint

ENV NODE_ENV=production \
    PORT=4000 \
    DB_DRIVER=sqlite \
    SQLITE_PATH=/var/lib/ozprint/ozprint.db \
    STORAGE_ROOT=/var/lib/ozprint \
    PYTHON_BINARY=/usr/bin/python3

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
