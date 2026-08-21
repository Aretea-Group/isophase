# syntax=docker/dockerfile:1
FROM oven/bun:1.3.4-slim

WORKDIR /app

# Install workspace dependencies from the lockfile only, so the layer caches
# across source edits.
#
# `--frozen-lockfile` validates the *entire* workspace set, not just the
# workspaces this image runs, so every workspace listed in bun.lock needs its
# manifest here — a missing one reads as "lockfile had changes" and fails the
# build. Adding a workspace to the monorepo means adding a COPY line below.
# `--filter` then narrows what is actually installed to this app's subtree.
COPY package.json bun.lock ./
COPY apps/console/package.json ./apps/console/
COPY apps/investigator/package.json ./apps/investigator/
COPY apps/mock-sentinel/package.json ./apps/mock-sentinel/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/sentinel-client/package.json ./packages/sentinel-client/
RUN bun install --frozen-lockfile --filter '@soc/mock-sentinel'

# Bun executes TypeScript directly; there is no build step.
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/mock-sentinel ./apps/mock-sentinel

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["bun", "apps/mock-sentinel/src/index.ts"]
