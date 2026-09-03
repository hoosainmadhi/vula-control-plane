# syntax=docker/dockerfile:1
# ZaPOS Control Plane — 2-stage build (house pattern, node:22-alpine)

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
WORKDIR /app
ENV NODE_ENV=production
ENV CP_DB_PATH=/data/control-plane.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY schema.sql ./
RUN mkdir -p /data
VOLUME /data
ENV PORT=3240
EXPOSE 3240
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3240/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
