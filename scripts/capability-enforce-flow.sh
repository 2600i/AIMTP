#!/usr/bin/env bash

set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}" || exit 1

ENV_FILE="${PROJECT_ROOT}/.env"
DEMO_CAP_FILE="/tmp/demo-cap.json"
TMP_DIR="$(mktemp -d /tmp/aimtp-cap-keys.XXXXXX)"
PUBLIC_PEM_FILE="${TMP_DIR}/cap-public.pem"
PRIVATE_PEM_FILE="${TMP_DIR}/cap-private.pem"

RELAY_ENV_OUTPUT=""
INSPECT_OUTPUT=""
VERIFY_OUTPUT=""
WITHOUT_CAP_RESPONSE=""
WITH_CAP_RESPONSE=""
WITHOUT_CAP_STATUS=""
WITH_CAP_STATUS=""

FAILURES=()

record_failure() {
  local message="$1"
  FAILURES+=("${message}")
  printf 'ERROR: %s\n' "${message}" >&2
}

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    record_failure "Missing required command: ${cmd}"
    return 1
  fi
  return 0
}

escape_pem_for_env() {
  local pem_file="$1"
  node -e "const fs=require('node:fs');const raw=fs.readFileSync(process.argv[1],'utf8');process.stdout.write(raw.replace(/\r?\n/g,'\\\\n'));" "${pem_file}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local src="${ENV_FILE}"
  local tmp
  tmp="$(mktemp)"
  if [ -f "${src}" ]; then
    grep -vE "^${key}=" "${src}" >"${tmp}" || true
  else
    : >"${tmp}"
  fi
  printf '%s=%s\n' "${key}" "${value}" >>"${tmp}"
  mv "${tmp}" "${src}"
}

read_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  if [ -z "${line}" ]; then
    return 1
  fi
  printf '%s' "${line#*=}"
  return 0
}

parse_status_code() {
  awk '/^HTTP\// { code=$2 } END { if (code != "") print code }'
}

printf '==> Step 1: Generate local Ed25519 capability keypair (PEM)\n'
if ! require_cmd node; then
  :
fi
if command -v node >/dev/null 2>&1; then
  if node - "${PUBLIC_PEM_FILE}" "${PRIVATE_PEM_FILE}" <<'NODE'
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");

const publicPath = process.argv[2];
const privatePath = process.argv[3];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

fs.writeFileSync(publicPath, publicPem, "utf8");
fs.writeFileSync(privatePath, privatePem, "utf8");
NODE
  then
    printf '%s\n' '----- AIMTP_CAP_PUBLIC_KEY (PEM) -----'
    cat "${PUBLIC_PEM_FILE}"
    printf '%s\n' '----- AIMTP_CAP_PRIVATE_KEY (PEM) -----'
    cat "${PRIVATE_PEM_FILE}"
  else
    record_failure "Failed to generate Ed25519 keypair"
  fi
fi

printf '==> Step 2: Write escaped PEM keys into .env and keep .env ignored\n'
if [ -f "${PUBLIC_PEM_FILE}" ] && [ -f "${PRIVATE_PEM_FILE}" ]; then
  public_env_value="$(escape_pem_for_env "${PUBLIC_PEM_FILE}")"
  private_env_value="$(escape_pem_for_env "${PRIVATE_PEM_FILE}")"
  upsert_env_value "AIMTP_CAP_PUBLIC_KEY" "${public_env_value}"
  upsert_env_value "AIMTP_CAP_PRIVATE_KEY" "${private_env_value}"
else
  record_failure "Cannot update .env because PEM files were not generated"
fi

if git check-ignore -q .env; then
  printf '.env is ignored by git.\n'
else
  record_failure ".env is not currently ignored by git"
fi

printf '==> Step 3: docker-compose relay env is configured in docker-compose.yml\n'
printf 'Configured relay env keys expected: AIMTP_CAP_PUBLIC_KEY, AIMTP_CAP_PRIVATE_KEY, INTENTOS=on, INTENTOS_MODE=enforce, AIMTP_CAPABILITIES=on, AIMTP_CAP_MODE=enforce.\n'

printf '==> Step 4: Restart Docker setup\n'
if ! require_cmd docker; then
  :
fi
if command -v docker >/dev/null 2>&1; then
  if ! docker compose down; then
    record_failure "docker compose down failed"
  fi
  if ! docker compose up --build -d; then
    record_failure "docker compose up --build -d failed"
  fi
fi

printf '==> Step 5: Verify relay env values\n'
if command -v docker >/dev/null 2>&1; then
  if RELAY_ENV_OUTPUT="$(docker compose exec -T relay sh -lc 'env | grep -E "^(INTENTOS|INTENTOS_MODE|AIMTP_CAPABILITIES|AIMTP_CAP_MODE)=" | sort' 2>&1)"; then
    printf '%s\n' "${RELAY_ENV_OUTPUT}"
    printf '%s\n' "${RELAY_ENV_OUTPUT}" | grep -q '^INTENTOS=on$' || record_failure "Relay env missing INTENTOS=on"
    printf '%s\n' "${RELAY_ENV_OUTPUT}" | grep -q '^INTENTOS_MODE=enforce$' || record_failure "Relay env missing INTENTOS_MODE=enforce"
    printf '%s\n' "${RELAY_ENV_OUTPUT}" | grep -q '^AIMTP_CAPABILITIES=on$' || record_failure "Relay env missing AIMTP_CAPABILITIES=on"
    printf '%s\n' "${RELAY_ENV_OUTPUT}" | grep -q '^AIMTP_CAP_MODE=enforce$' || record_failure "Relay env missing AIMTP_CAP_MODE=enforce"
  else
    record_failure "Failed to read relay environment variables"
  fi
fi

printf '==> Step 6: Mint demo read-only capability\n'
if command -v node >/dev/null 2>&1; then
  escaped_pub="$(read_env_value AIMTP_CAP_PUBLIC_KEY || true)"
  escaped_priv="$(read_env_value AIMTP_CAP_PRIVATE_KEY || true)"
  if [ -z "${escaped_pub}" ] || [ -z "${escaped_priv}" ]; then
    record_failure "AIMTP capability keys are missing from .env"
  else
    export AIMTP_CAP_PUBLIC_KEY
    export AIMTP_CAP_PRIVATE_KEY
    AIMTP_CAP_PUBLIC_KEY="$(printf '%b' "${escaped_pub}")"
    AIMTP_CAP_PRIVATE_KEY="$(printf '%b' "${escaped_priv}")"
    if ! node tools/aimtp-cap.mjs mint \
      --issuer local-admin \
      --subject demo-ui \
      --aud http://localhost:8787/aimtp \
      --ttl 900 \
      --actions intentos.read \
      --resources intentos:intents,intentos:tasks,intentos:intent/demo-intent-001 \
      --out "${DEMO_CAP_FILE}"; then
      record_failure "Capability mint failed"
    fi
  fi
fi

printf '==> Step 7: Inspect and verify minted capability\n'
if command -v node >/dev/null 2>&1 && [ -f "${DEMO_CAP_FILE}" ]; then
  if INSPECT_OUTPUT="$(node tools/aimtp-cap.mjs inspect --file "${DEMO_CAP_FILE}" --aud http://localhost:8787/aimtp 2>&1)"; then
    printf '%s\n' "${INSPECT_OUTPUT}"
  else
    printf '%s\n' "${INSPECT_OUTPUT}"
    record_failure "Capability inspect failed"
  fi

  if VERIFY_OUTPUT="$(node tools/aimtp-cap.mjs verify --file "${DEMO_CAP_FILE}" --aud http://localhost:8787/aimtp 2>&1)"; then
    printf '%s\n' "${VERIFY_OUTPUT}"
  else
    printf '%s\n' "${VERIFY_OUTPUT}"
    record_failure "Capability verify failed"
  fi
else
  record_failure "Missing ${DEMO_CAP_FILE}; cannot run inspect/verify"
fi

printf '==> Step 8: Enforce-mode API checks\n'
if command -v curl >/dev/null 2>&1; then
  WITHOUT_CAP_RESPONSE="$(curl -sS -i http://localhost:8787/aimtp/intentos/intents 2>&1 || true)"
  WITHOUT_CAP_STATUS="$(printf '%s\n' "${WITHOUT_CAP_RESPONSE}" | parse_status_code)"

  if [ -f "${DEMO_CAP_FILE}" ]; then
    compact_cap_json="$(node -e "const fs=require('node:fs');const cap=JSON.parse(fs.readFileSync('${DEMO_CAP_FILE}','utf8'));process.stdout.write(JSON.stringify(cap));")"
    WITH_CAP_RESPONSE="$(curl -sS -i -H "X-AIMTP-Capability: ${compact_cap_json}" http://localhost:8787/aimtp/intentos/intents 2>&1 || true)"
    WITH_CAP_STATUS="$(printf '%s\n' "${WITH_CAP_RESPONSE}" | parse_status_code)"
  else
    record_failure "Missing ${DEMO_CAP_FILE} for capability-auth curl check"
  fi

  case "${WITHOUT_CAP_STATUS}" in
    401|403)
      ;;
    *)
      record_failure "Expected non-cap request to be 401/403, got '${WITHOUT_CAP_STATUS:-<none>}'"
      ;;
  esac

  if [ "${WITH_CAP_STATUS}" != "200" ]; then
    record_failure "Expected cap-auth request to be 200, got '${WITH_CAP_STATUS:-<none>}'"
  fi
fi

printf '\n===== Final Summary =====\n'
printf 'Project root: %s\n' "${PROJECT_ROOT}"

printf '\nRelay environment (from container):\n'
if [ -n "${RELAY_ENV_OUTPUT}" ]; then
  printf '%s\n' "${RELAY_ENV_OUTPUT}"
else
  printf 'Unavailable\n'
fi

printf '\nMinted capability:\n'
if [ -f "${DEMO_CAP_FILE}" ]; then
  printf 'File: %s\n' "${DEMO_CAP_FILE}"
  node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('${DEMO_CAP_FILE}','utf8'));const leaf=(Array.isArray(p.chain)&&p.chain.length>0)?p.chain[p.chain.length-1]:null;console.log(JSON.stringify({issuer:leaf&&leaf.issuer,subject:leaf&&leaf.subject,aud:leaf&&leaf.aud,iat:leaf&&leaf.iat,exp:leaf&&leaf.exp,scopes:leaf&&leaf.scopes},null,2));"
else
  printf 'Not created\n'
fi

printf '\nCurl without capability (status: %s):\n' "${WITHOUT_CAP_STATUS:-unknown}"
if [ -n "${WITHOUT_CAP_RESPONSE}" ]; then
  printf '%s\n' "${WITHOUT_CAP_RESPONSE}"
else
  printf 'No response captured\n'
fi

printf '\nCurl with capability header (status: %s):\n' "${WITH_CAP_STATUS:-unknown}"
if [ -n "${WITH_CAP_RESPONSE}" ]; then
  printf '%s\n' "${WITH_CAP_RESPONSE}"
else
  printf 'No response captured\n'
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nErrors:\n'
  for failure in "${FAILURES[@]}"; do
    printf '%s\n' "- ${failure}"
  done
  exit 1
fi

printf '\nAll steps completed successfully.\n'
