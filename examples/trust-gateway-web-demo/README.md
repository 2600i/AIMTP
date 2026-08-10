# Agent Trust Gateway web demo

This browser demo presents the implemented Gateway decision flow as a short,
investor- and agency-friendly story. It uses the real `AgentTrustGateway`, real
ephemeral Ed25519 signatures, real policy evaluation, real replay protection,
and a simulated protected purchase handler.

Run it locally:

```sh
npm ci
npm run demo:trust-gateway:web
```

Then open <http://127.0.0.1:8090> and select **Run guided demo**.

The guided flow demonstrates:

1. A trusted agent's $25 purchase is allowed and executed.
2. Its $250 purchase is held for human approval.
3. The local demo operator approves the original request.
4. A second approval cannot execute the purchase again.
5. A replayed signed envelope is denied.
6. A validly signed but unknown agent is denied.
7. The resulting decision and execution evidence is visible in the audit view.

The purchase handler is deliberately simulated. This demo does not perform a
payment or claim crash-safe end-to-end exactly-once settlement. What it does
show is that within this Gateway boundary a duplicate approval and a replayed
envelope are both refused.

## Sessions

Each caller gets its own Gateway, keyed by an `x-aimtp-demo-session` header the
server mints on first contact and the client echoes back.

That is not decoration. The controller holds live Gateway state — the pending
approval id, the used envelope ids, the audit trail — so a single shared
instance is only correct for a single-user local run. Behind a public URL two
visitors would share one Gateway and the second one's approval would claim the
first one's held request. The failure is silent: the demo still answers, it just
answers about somebody else's requests.

Sessions are bounded in both directions — idle ones expire, and the cap evicts
the least recently used — so a flood of session ids costs a fixed amount of
memory. `DEMO_SESSION_TTL_MS`, `DEMO_MAX_SESSIONS`,
`DEMO_SESSION_RATE_LIMIT` and `DEMO_SESSION_RATE_WINDOW_MS` tune it.

Passing a controller to `createDemoServer(controller)` pins every caller to one
Gateway instead. That is what the tests use, and what a deliberately shared
single-user run wants.

## As a service

[`docker-compose.demo.yml`](../../docker-compose.demo.yml) runs this as the
sidecar behind the public demo on `aimtp.2600i.com`. The website has no copy of
the Gateway and cannot get one, so it proxies here; keys and signing never leave
this side.

The service has no authentication of its own. It is deliberately not published
to the host — only the website reaches it, over a shared Docker network.
