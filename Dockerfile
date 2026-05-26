# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN corepack enable

# Native modules (better-sqlite3, pulled in via @actual-app/api) have no musl
# prebuilds, so they compile from source on alpine — install the toolchain.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
RUN yarn build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN corepack enable

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
# better-sqlite3 recompiles for the production install too; install the build
# toolchain as a virtual package and drop it afterward to keep the image lean.
# cups-client provides `lp` so scheduled briefs can print to a CUPS server.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && yarn workspaces focus --production \
  && yarn cache clean \
  && apk del .build-deps \
  && apk add --no-cache cups-client

COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/web/dist/ ./web/dist/
COPY fonts/ ./fonts/
COPY config.example.yaml ./config.example.yaml

# Default to headless docker mode
ENV MODE=headless_docker
ENV TZ=America/Chicago
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ "$MODE" = "headed_docker" ]; then wget -qO- http://localhost:3000/api/health || exit 1; else exit 0; fi

ENTRYPOINT ["node", "dist/entrypoint.js"]
