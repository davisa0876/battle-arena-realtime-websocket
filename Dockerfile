# syntax=docker/dockerfile:1.7

# Battle Arena realtime gateway — multi-stage, non-root, Node.js Active LTS
ARG NODE_VERSION=26.13.1

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

RUN groupadd --system --gid 10001 realtime \
  && useradd --system --uid 10001 --gid realtime --home-dir /app --shell /usr/sbin/nologin realtime

COPY --from=build --chown=realtime:realtime /app/package.json /app/package-lock.json ./
COPY --from=build --chown=realtime:realtime /app/node_modules ./node_modules
COPY --from=build --chown=realtime:realtime /app/dist ./dist

USER realtime
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=10s \
  CMD ["node", "dist/healthcheck.js"]

CMD ["node", "dist/index.js"]
