# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS tooling
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM tooling AS build
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.browser.json ./
COPY scripts/build-browser.ts scripts/build-vps.ts ./scripts/
COPY src ./src
RUN pnpm build

FROM tooling AS production-dependencies
# Client 已在构建阶段生成并打包；运行依赖无需安装脚本或数据库凭据。
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/vps ./dist/vps
COPY --chown=node:node package.json ./package.json
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/vps/main.js"]
