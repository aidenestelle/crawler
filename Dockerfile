# Estellebot — HIPAA deep-scan worker
# Multi-stage build: deps -> build -> runtime
# Base image tracks the Playwright version pinned in package.json (1.49.1).

# -----------------------------------------------------------------------------
# Stage 1: deps — install all deps (dev + prod) for the build step.
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS deps
WORKDIR /app
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# -----------------------------------------------------------------------------
# Stage 2: build — compile TypeScript to dist/.
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS build
WORKDIR /app
RUN npm install -g pnpm@9
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime — prod-only node_modules + compiled dist.
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN npm install -g pnpm@9

# Install prod-only dependencies (no dev deps).
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Copy compiled output from build stage.
COPY --from=build /app/dist ./dist

# Copy non-TS assets that tsc does not bundle (data files, vendored JSON).
COPY --from=build /app/src/data ./dist/data

# /healthz endpoint listens on PORT (default 8080).
EXPOSE 8080

LABEL org.opencontainers.image.title="estellebot"
LABEL org.opencontainers.image.description="HIPAA deep-scan worker for Estelle Digital"
LABEL org.opencontainers.image.source="https://github.com/estelledigital/estellebot"

CMD ["node", "dist/index.js"]
