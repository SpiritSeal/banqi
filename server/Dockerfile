# Production image for the banqi relay server.
# pg is pure JS — no native build tools needed.
# Build from repo root:
#   docker build -f server/Dockerfile -t banqi-relay .
# Run locally:
#   docker run -p 8080:8080 \
#     -e DATABASE_URL=postgresql://user:pass@host/dbname \
#     -e SERVER_SECRET=... -e GITHUB_CLIENT_ID=... banqi-relay

FROM node:lts-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:lts-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json server/schema.sql ./
COPY server/src ./src
COPY web /web
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.mjs"]
