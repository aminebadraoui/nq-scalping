# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# compile the Tradovate md collector + recapture script to plain CJS
# (Node 22 runtime has no TS type-stripping, and the repo's ts-loader
# lives outside this context)
RUN npx tsc scripts/tradovateMd.ts scripts/tvmdRecapture.ts lib/tradovateMdProtocol.ts \
    --outDir /tvmd-dist --module commonjs --moduleResolution node \
    --target es2022 --lib es2022 --esModuleInterop --skipLibCheck --noEmit false

# ---- runtime (Next standalone) -------------------------------------------
FROM node:22-alpine AS run
# Coolify runs the container healthcheck FROM INSIDE the container (GET / on
# the exposed port) and alpine has no curl/wget by default — without this the
# check fails every 5s and the app restarts in a loop. Chromium drives the
# token-recapture browser (scripts/tvmdRecapture.js) headlessly.
RUN apk add --no-cache curl chromium
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Coolify passes SOURCE_COMMIT (the deployed git SHA) as a build arg — the
# daybook variation fingerprint uses it (empty → fingerprint falls back to
# the settings hash alone).
ARG SOURCE_COMMIT
ENV BUILD_SHA=${SOURCE_COMMIT}

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Tradovate md collector (compiled JS) + supervised entrypoint
COPY --from=build /tvmd-dist /app/tvmd
COPY --from=build /app/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# collected feed data can be mounted here (GC_DATA_DIR=/app/data) — the
# daybook journal + guard state file + tradovate md journal live on this
# volume (TVMD_OUT / TVMD_TOKEN_FILE default inside it)
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["/app/docker-entrypoint.sh"]
