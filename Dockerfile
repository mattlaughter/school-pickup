# ---------------------------------------------------------------------------
# Pickup — single container, everything inside.
#
# Build stage compiles better-sqlite3 if a prebuilt binary isn't available for
# the target architecture (this is what makes the image work on both an Intel
# server and an ARM box without you having to think about it).
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund


# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

# sqlite3 CLI is included so anyone with a shell on this container can inspect
# or dump the database without installing anything.
RUN apt-get update && apt-get install -y --no-install-recommends \
      sqlite3 tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js db.js seed.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8888 \
    DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8888
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8888/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM so `docker stop` closes the database
# cleanly instead of killing it mid-write.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
