# learn: Bun API + PWA host + pipeline worker. Build context is the repo root
# so we can copy both server/ and the built app/dist. Layout under /srv mirrors
# the repo (server/src ↔ ../../app/dist) so the static handler resolves.
FROM oven/bun:1.3.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server/ ./
# Build the PWA first: (cd app && bun install && bun run build)
COPY app/dist /srv/app/dist

ENV PORT=7900 DATA_DIR=/data
EXPOSE 7900
CMD ["bun", "run", "src/index.ts"]
