# syntax=docker/dockerfile:1
FROM oven/bun:1.3.4-slim

WORKDIR /app

# Install workspace dependencies from the lockfile only, so the layer caches
# across source edits.
COPY package.json bun.lock ./
COPY apps/mock-sentinel/package.json ./apps/mock-sentinel/
COPY packages/contracts/package.json ./packages/contracts/
RUN bun install --frozen-lockfile

# Bun executes TypeScript directly; there is no build step.
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/mock-sentinel ./apps/mock-sentinel

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["bun", "apps/mock-sentinel/src/index.ts"]
