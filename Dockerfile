# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# Dev dependencies (typescript, tsx) are needed here and only here: `npm run
# build` runs tsc and then scripts/copy-migrations.mjs, which stages the .sql
# files into dist/ so the migration runner can find them at runtime.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# --omit=dev keeps typescript and vitest out of the deployed image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Nothing in this process needs to write to disk or bind a privileged port.
USER node

EXPOSE 8787

# config.ts defaults CRM_HTTP_PORT to 8787; fly.toml pins the same number as
# internal_port. Change one and you must change the other.
CMD ["node", "dist/index.js"]
