# Minimal production image. Runs the relay against a SQLite file in /data.
# Build:  docker build -t banqi-relay server/
# Run:    docker run -p 8080:8080 -v banqi-data:/data \
#               -e SERVER_SECRET=... -e GITHUB_CLIENT_ID=... ... banqi-relay

FROM node:lts-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN apk add --no-cache python3 make g++ \
 && npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:lts-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json server/schema.sql ./
COPY server/src ./src
COPY web /web
ENV NODE_ENV=production
ENV DATABASE_FILE=/data/banqi.db
ENV PORT=8080
EXPOSE 8080
VOLUME ["/data"]
RUN mkdir -p /data
CMD ["node", "src/index.mjs"]
