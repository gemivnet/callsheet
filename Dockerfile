# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN corepack enable

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY tsconfig.json ./
COPY src/ ./src/
RUN yarn build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN corepack enable

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn workspaces focus --production && yarn cache clean

COPY --from=build /app/dist/ ./dist/
COPY fonts/ ./fonts/
COPY config.example.yaml ./config.example.yaml

# Default to headless docker mode
ENV MODE=headless_docker
ENV TZ=America/Chicago
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ "$MODE" = "headed_docker" ]; then wget -qO- http://localhost:3000/api/health || exit 1; else exit 0; fi

ENTRYPOINT ["node", "dist/cli.js"]
