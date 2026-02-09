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

- v0.2 introduces no new auth model.
- In `INTENTOS_MODE=log`, the UI behaves like existing read endpoints.
- In `INTENTOS_MODE=enforce`, UI API calls MUST satisfy the same identity/capability checks already enforced by the read endpoints.
- The UI MUST surface read errors from those API calls to the user without attempting fallback writes.
