# syntax=docker/dockerfile:1

# ---- Build stage ------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# pnpm comes from corepack, which reads the pinned `packageManager` field in
# package.json — there is no version to duplicate here.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# pnpm-workspace.yaml marks this directory as its own workspace root and carries
# the build-script allow-list. Without it pnpm walks up to a parent workspace and
# resolves against the wrong tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

# `build` = check:cycles (madge) + clean + tsc + chmod, so it needs devDeps.
RUN pnpm build

# ---- Runtime stage ----------------------------------------------------------
FROM node:22-slim

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=1731
ENV HUB_DATA_DIR=/data

# Owned by `node` so a fresh named volume mounted here inherits that ownership.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 1731

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1731)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
