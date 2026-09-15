# syntax=docker/dockerfile:1
# Vula Control Plane — 2-stage build (house pattern, node:22-alpine)

FROM node:22-alpine AS build
WORKDIR /app
# Coolify injects NODE_ENV=production as a build arg — force dev deps for tsc.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY server.ts tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
ENV NODE_ENV=production
ENV CP_DB_PATH=/data/control-plane.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY schema.sql ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data
VOLUME /data
# Coolify injects PORT=3000 for its proxy, so the default, the exposed port and
# the healthcheck all agree on 3000. A healthcheck probing a port the proxy does
# not reach marks a working container unhealthy, which reads as a failed deploy.
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health >/dev/null 2>&1 || exit 1
# Starts as root only to make the bind-mounted /data writable by `node`, then
# drops to `node` before the server starts — see the script's header.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
