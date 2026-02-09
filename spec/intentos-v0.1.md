# IntentOS v0.1

This document tracks additive IntentOS behavior layered on AIMTP runtime endpoints.

## IntentOS v0.2 (Read-only Web Inbox)

IntentOS v0.2 adds a small read-only web inbox served by the relay HTTP server.

### UI Endpoints

- `GET /intentos/ui` MUST serve the IntentOS inbox HTML shell.
- `GET /intentos/ui/` MUST behave the same as `GET /intentos/ui`.
- `GET /intentos/ui/app.js` MUST serve the UI JavaScript.
- `GET /intentos/ui/styles.css` MUST serve the UI CSS.

### Read-only Scope

- The UI MUST be read-only.
- The UI MUST NOT issue write operations (no submit/claim/result actions).
- The UI reads from existing IntentOS read endpoints:
  - `GET /intentos/intents`
  - `GET /intentos/intent/:id`
  - `GET /intentos/tasks`

### Feature Gating

- `/intentos/ui*` routes MUST require `INTENTOS=on`.
- If `INTENTOS` is not enabled, `/intentos/ui*` MUST return `404`.

### Auth and Enforcement

- IntentOS API authorization uses AIMTP capabilities when `AIMTP_CAPABILITIES=on`.
- Audience (`aud`) MUST exactly match the relay base URL (for example `http://localhost:8787/aimtp`).
- Scope matching is exact (`action` + `resource`), without wildcard expansion.

Required scope mapping:
- `GET /intentos/intents` => `action=intentos.read`, `resource=intentos:intents`
- `GET /intentos/tasks` => `action=intentos.read`, `resource=intentos:tasks`
- `GET /intentos/intent/:id` => `action=intentos.read`, `resource=intentos:intent/<id>`
- `POST /intentos/task/:id/claim` => `action=intentos.task.claim`, `resource=intentos:task/<id>`
- `POST /intentos/task/:id/result` => `action=intentos.task.result`, `resource=intentos:task/<id>`

Mode semantics:
- In `INTENTOS_MODE=log`, missing or invalid capabilities MUST be logged and requests MAY proceed.
- In `INTENTOS_MODE=enforce` with `AIMTP_CAP_MODE=enforce`, all IntentOS API endpoints (read and write) MUST require a valid, exact-scope capability.
- Missing capability in enforce mode MUST return `403` with `code=capability_required`.
- Invalid capability (bad format/signature/aud/expired/scope mismatch) in enforce mode MUST return `403` with `code=capability_invalid`.
- The UI MUST surface read errors from those API calls to the user without attempting fallback writes.
