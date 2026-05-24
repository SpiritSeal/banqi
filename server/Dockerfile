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
# The node:lts-alpine image ships a pre-created non-root `node` user (uid 1000).
# Chown every COPY so the runtime user can read the files without needing to
# run as root. The stamp-sw RUN step below still executes as root (the default)
# because /tmp ownership and the cleanup `rm` are simpler that way; we drop
# privileges with USER node right before CMD so only the long-running process
# is non-root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server/package.json server/schema.sql ./
COPY --chown=node:node server/src ./src
COPY --chown=node:node server/scripts ./scripts
COPY --chown=node:node web /web
# The AI engine lives at top-level ai/ so the relay server can import it
# without dragging the whole web/ tree into its own stability surface. The
# browser still fetches it (via the /ai static mount in src/index.mjs) so we
# ship it alongside the web bundle here.
COPY --chown=node:node ai /ai
# Stamp the service worker against the actual shipped web/ + ai/ contents.
# Done inside the image build so the BUILD_ID always matches what's served,
# even if the developer forgot `make stamp-sw` locally. The script has no
# runtime deps and the alpine image already has node, so this is a no-cost
# step.
COPY scripts/stamp-sw.mjs /tmp/stamp-sw.mjs
RUN node /tmp/stamp-sw.mjs --web /web --ai /ai && rm /tmp/stamp-sw.mjs
ENV NODE_ENV=production
ENV PORT=8080
# This image is meant to run behind a TLS-terminating reverse proxy (Cloud
# Run, nginx, Cloudflare). PUBLIC_URL=https://… puts the session cookie in
# Secure mode, which makes express-session require req.secure === true; that
# in turn requires Express to trust the proxy's X-Forwarded-Proto header.
# Without this default, deploys silently drop the session Set-Cookie on the
# OAuth callback and every sign-in (GitHub / Google / dev) lands on
# /?auth=fail with no session. Override with `-e TRUST_PROXY=` if exposing
# the container directly without a proxy in front (rare; also disables the
# per-IP guest-session rate limit).
ENV TRUST_PROXY=1
EXPOSE 8080
USER node
CMD ["node", "src/index.mjs"]
