# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime (Next standalone) -------------------------------------------
FROM node:22-alpine AS run
# Coolify runs the container healthcheck FROM INSIDE the container (GET / on
# the exposed port) and alpine has no curl/wget by default — without this the
# check fails every 5s and the app restarts in a loop.
RUN apk add --no-cache curl
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

# collected feed data can be mounted here (GC_DATA_DIR=/app/data) — the
# daybook journal + guard state file live on this volume
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
