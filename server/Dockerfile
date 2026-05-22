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
# The AI engine lives at top-level ai/ so the relay server can import it
# without dragging the whole web/ tree into its own stability surface. The
# browser still fetches it (via the /ai static mount in src/index.mjs) so we
# ship it alongside the web bundle here.
COPY ai /ai
# Stamp the service worker against the actual shipped web/ + ai/ contents.
# Done inside the image build so the BUILD_ID always matches what's served,
# even if the developer forgot `make stamp-sw` locally. The script has no
# runtime deps and the alpine image already has node, so this is a no-cost
# step.
COPY scripts/stamp-sw.mjs /tmp/stamp-sw.mjs
RUN node /tmp/stamp-sw.mjs --web /web --ai /ai && rm /tmp/stamp-sw.mjs
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.mjs"]
