#!/usr/bin/env bash
# One-shot deployment: Neon (project + database + backfill) + Coolify (app + deploy).
#
#   export COOLIFY_URL=https://coolify.yourdomain.com
#   export COOLIFY_TOKEN=...          # write + deploy permissions
#   export NEON_API_KEY=napi_...      # account or org key
#   ./deploy/setup.sh [--domain nq.coolify.example.com]
#
# Idempotent: existing resources are reused. Everything it creates is reported
# at the end. See DEPLOY.md for the manual equivalent.
set -euo pipefail

CF="${COOLIFY_URL%/}"
CT="${COOLIFY_TOKEN:?set COOLIFY_TOKEN}"
NK="${NEON_API_KEY:?set NEON_API_KEY}"
NEON="https://console.neon.tech/api/v2"
DOMAIN="${1#--domain }"; [ "$DOMAIN" = "$1" ] && DOMAIN=""

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# ---------- 1 · Neon: project + database ----------
say "Neon: ensure project exists"
ORG_ID=""
if [ -n "${NEON_ORG_ID:-}" ]; then ORG_ID="$NEON_ORG_ID"; fi
PROJ_JSON=$(curl -s -H "Authorization: Bearer $NK" "$NEON/projects?limit=100" | jq -c '.projects[] | select(.name=="nq-store")' 2>/dev/null || true)
if [ -z "$PROJ_JSON" ]; then
  say "Neon: creating project nq-store"
  BODY=$(jq -nc --arg org "$ORG_ID" '{project:{name:"nq-store",org_id:$org,region_id:"aws-us-east-1",pg_version:17}}')
  if [ -z "$ORG_ID" ]; then BODY=$(jq -nc '{project:{name:"nq-store",region_id:"aws-us-east-1",pg_version:17}}'); fi
  curl -s -H "Authorization: Bearer $NK" -H "Content-Type: application/json" -d "$BODY" "$NEON/projects" > /tmp/neon_project.json
  PROJ_ID=$(jq -r '.project.id' /tmp/neon_project.json)
else
  PROJ_ID=$(echo "$PROJ_JSON" | jq -r '.id')
  say "Neon: reusing project $PROJ_ID"
fi
BRANCH_ID=$(curl -s -H "Authorization: Bearer $NK" "$NEON/projects/$PROJ_ID/branches" | jq -r '.branches[] | select(.name=="main") | .id' | head -1)
ROLE_PASS=$(curl -s -H "Authorization: Bearer $NK" "$NEON/projects/$PROJ_ID/branches/$BRANCH_ID/roles" | jq -r '.roles[] | select(.name=="neondb_owner") | .password')
DB_URL="postgresql://neondb_owner:${ROLE_PASS}@$(curl -s -H "Authorization: Bearer $NK" "$NEON/projects/$PROJ_ID/endpoints" | jq -r '.endpoints[0].host')/neondb?sslmode=require"
say "Neon: DATABASE_URL obtained"

# ---------- 2 · backfill everything we have ----------
say "Ingesting all collected data into Neon"
cd "$(dirname "$0")/.."
DATABASE_URL="$DB_URL" node --import ./scripts/ts-loader.mjs ./web/db/ingest.ts --all --profiles --events
DATABASE_URL="$DB_URL" node --import ./scripts/ts-loader.mjs ./web/db/ingest.ts --verify

# ---------- 3 · Coolify: project + environment + app ----------
say "Coolify: project + environment"
PROJ=$(curl -s -H "Authorization: Bearer $CT" "$CF/api/v1/projects" | jq -c '.[] | select(.name=="scalping")' 2>/dev/null || true)
if [ -z "$PROJ" ]; then
  PROJ_UUID=$(curl -s -X POST -H "Authorization: Bearer $CT" -H "Content-Type: application/json" -d '{"name":"scalping"}' "$CF/api/v1/projects" | jq -r '.uuid')
else
  PROJ_UUID=$(echo "$PROJ" | jq -r '.uuid')
fi
ENV_UUID=$(curl -s -H "Authorization: Bearer $CT" "$CF/api/v1/projects/$PROJ_UUID/environments" | jq -r '.[] | select(.name=="production") | .uuid' 2>/dev/null || true)
if [ -z "$ENV_UUID" ]; then
  ENV_UUID=$(curl -s -X POST -H "Authorization: Bearer $CT" -H "Content-Type: application/json" -d '{"name":"production"}' "$CF/api/v1/projects/$PROJ_UUID/environments" | jq -r '.uuid')
fi
SERVER_UUID=$(curl -s -H "Authorization: Bearer $CT" "$CF/api/v1/servers" | jq -r '.[0].uuid')
say "Coolify: application from the private repo"
APP_BODY=$(jq -nc --arg p "$PROJ_UUID" --arg s "$SERVER_UUID" --arg e "$ENV_UUID" --arg d "$DOMAIN" \
  '{project_uuid:$p,server_uuid:$s,environment_uuid:$e,environment_name:"production",
    git_repository:"https://github.com/aminebadraoui/nq-scalping.git",git_branch:"main",
    build_pack:"dockerfile",base_directory:"web",name:"nq-dashboard",
    ports_exposes:"3000",health_check_port:"3000",health_check_enabled:true,instant_deploy:true,
    domains:$d}')
APP_UUID=$(curl -s -X POST -H "Authorization: Bearer $CT" -H "Content-Type: application/json" -d "$APP_BODY" "$CF/api/v1/applications/public" | jq -r '.uuid')
say "Coolify: environment variables"
ENVS=$(jq -nc --arg db "$DB_URL" \
  '{data:[{key:"DATABASE_URL",value:$db,is_preview:false,is_literal:false,is_multiline:false,is_shown_once:false},
          {key:"GC_DATA_DIR",value:"/app/data",is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false}]}')
curl -s -X PATCH -H "Authorization: Bearer $CT" -H "Content-Type: application/json" -d "$ENVS" "$CF/api/v1/applications/$APP_UUID/envs/bulk" > /dev/null
# GoCharting feed credentials for the live socket
if [ -f gcdata/.env ]; then
  set -a; . gcdata/.env; set +a
  GCE=$(jq -nc --arg e "$GOCHARTING_EMAIL" --arg p "$GOCHARTING_PASSWORD" --arg c "$GOCHARTING_COGNITO_CLIENT" --arg dc "$GOCHARTING_DC" --arg s "$GOCHARTING_SYMBOL" --arg x "$GOCHARTING_EXCHANGE" --arg seg "$GOCHARTING_SEGMENT" \
    '{data:[{key:"GOCHARTING_EMAIL",value:$e,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_PASSWORD",value:$p,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_COGNITO_CLIENT",value:$c,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_DC",value:$dc,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_SYMBOL",value:$s,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_EXCHANGE",value:$x,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false},
            {key:"GOCHARTING_SEGMENT",value:$seg,is_preview:false,is_literal:true,is_multiline:false,is_shown_once:false}]}')
  curl -s -X PATCH -H "Authorization: Bearer $CT" -H "Content-Type: application/json" -d "$GCE" "$CF/api/v1/applications/$APP_UUID/envs/bulk" > /dev/null
fi

say "Coolify: deploying"
curl -s -X POST -H "Authorization: Bearer $CT" "$CF/api/v1/deploy?uuid=$APP_UUID" > /dev/null

say "DONE"
echo "  app uuid : $APP_UUID"
echo "  database : $DB_URL"
echo "  url      : ${DOMAIN:-http://SERVER_IP:3000}"
echo "  next     : watch the deploy with  curl -H \"Authorization: Bearer \$COOLIFY_TOKEN\" $CF/api/v1/applications/$APP_UUID"
