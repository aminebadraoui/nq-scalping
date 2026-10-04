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

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# collected feed data can be mounted here (GC_DATA_DIR=/app/data)
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
