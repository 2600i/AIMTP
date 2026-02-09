"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { verifyRelayDescriptor } = require("../../runtime/federation");

const ROOT = path.resolve(__dirname, "../..");
const API_KEY = "smoke-federation-key";
const RECIPIENT = "user:b.test";

const RELAY_BOOTSTRAP = `
const { WebhookRelay } = require("./runtime/relay");
const { createWebhookRelayServer } = require("./runtime/http");

const relay = new WebhookRelay({ emitResponses: true });
relay.registerAgent("aimtp-relay", async () => {});

const port = Number(process.env.PORT || 8787);
const server = createWebhookRelayServer(relay, {});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "smoke_relay_started", port }));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;

const managedChildren = [];
let tempDir = "";

function nowIso() {
  return new Date().toISOString();
}

function logLine(message) {
  process.stdout.write(`[federation-smoke] ${message}\n`);
}

function fail(message, extra) {
  const suffix = extra ? `\n${extra}` : "";
  throw new Error(`FAIL: ${message}${suffix}`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_err) {
    return null;
  }
}

function createEd25519KeyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPkcs8Base64: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64")
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, urlString, payload, headers = {}, timeoutMs = 5000) {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const requestHeaders = Object.assign({}, headers);
  if (payload !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestHeaders["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        method,
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (raw) {
            try {
              json = JSON.parse(raw);
            } catch (_err) {
              json = null;
            }
          }
          resolve({
            status: typeof res.statusCode === "number" ? res.statusCode : 0,
            headers: res.headers,
            raw,
            json
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request_timeout"));
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function waitForHealth(baseUrl, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await requestJson("GET", `${baseUrl}/healthz`);
      if (res.status === 200 && res.json && res.json.status === "ok") {
        return;
      }
      lastError = `status=${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await wait(150);
  }
  fail(`Relay ${label} did not become healthy`, lastError);
}

function spawnRelay(name, env) {
  const child = spawn(process.execPath, ["-e", RELAY_BOOTSTRAP], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = [];
  const collect = (source, chunk) => {
    const text = chunk.toString("utf8");
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => {
        logs.push({ source, line, parsed: parseJsonLine(line) });
      });
  };

  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));

  managedChildren.push(child);

  return { child, logs, name };
}

function writeTrustStore(filePath, trustedRelay, domainMap) {
  const payload = {
    trusted_relays: [trustedRelay],
    domains: domainMap
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function eventSeen(logs, event, predicate) {
  return logs.some((entry) => {
    if (!entry.parsed || entry.parsed.event !== event) {
      return false;
    }
    return typeof predicate === "function" ? predicate(entry.parsed) : true;
  });
}

async function waitForEvent(logs, event, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (eventSeen(logs, event, predicate)) {
      return true;
    }
    await wait(100);
  }
  return false;
}

async function cleanup() {
  const killPromises = managedChildren.map(
    (child) =>
      new Promise((resolve) => {
        if (!child || child.killed) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill("SIGKILL");
            } catch (_err) {
              // no-op
            }
          }
          resolve();
        }, 1000).unref();
      })
  );

  await Promise.all(killPromises);

  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  logLine("Starting Phase 7 federation smoke test");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-fed-smoke-"));

  const portA = await getFreePort();
  const portB = await getFreePort();

  const keysA = createEd25519KeyMaterial();
  const keysB = createEd25519KeyMaterial();

  const relayA = {
    relayId: "relay.a.test",
    endpoint: `http://127.0.0.1:${portA}`,
    localDomain: "a.test",
    keys: keysA
  };
  const relayB = {
    relayId: "relay.b.test",
    endpoint: `http://127.0.0.1:${portB}`,
    localDomain: "b.test",
    keys: keysB
  };

  const trustAPath = path.join(tempDir, "trust-a.json");
  const trustBPath = path.join(tempDir, "trust-b.json");

  writeTrustStore(
    trustAPath,
    {
      relay_id: relayB.relayId,
      endpoint: relayB.endpoint,
      public_key: relayB.keys.publicKeySpkiBase64,
      alg: "ed25519",
      expires_at: "2099-01-01T00:00:00Z"
    },
    {
      "b.test": relayB.relayId
    }
  );

  writeTrustStore(
    trustBPath,
    {
      relay_id: relayA.relayId,
      endpoint: relayA.endpoint,
      public_key: relayA.keys.publicKeySpkiBase64,
      alg: "ed25519",
      expires_at: "2099-01-01T00:00:00Z"
    },
    {
      "a.test": relayA.relayId
    }
  );

  const commonEnv = {
    AIMTP_API_KEY: API_KEY,
    AIMTP_STORE: "memory",
    AIMTP_SIGNATURE_POLICY: "off",
    AIMTP_FEDERATION: "on",
    AIMTP_TEST_MODE: "on",
    NODE_ENV: "test"
  };

  const relayAProc = spawnRelay("relay-a", {
    ...commonEnv,
    PORT: String(portA),
    AIMTP_RELAY_ID: relayA.relayId,
    AIMTP_RELAY_ENDPOINT: relayA.endpoint,
    AIMTP_LOCAL_DOMAINS: relayA.localDomain,
    AIMTP_RELAY_PUBLIC_KEY: relayA.keys.publicKeySpkiBase64,
    AIMTP_RELAY_PRIVATE_KEY: relayA.keys.privateKeyPkcs8Base64,
    AIMTP_TRUSTED_RELAYS_PATH: trustAPath,
    AIMTP_ALLOWLIST_RECIPIENTS: "0"
  });

  const relayBProc = spawnRelay("relay-b", {
    ...commonEnv,
    PORT: String(portB),
    AIMTP_RELAY_ID: relayB.relayId,
    AIMTP_RELAY_ENDPOINT: relayB.endpoint,
    AIMTP_LOCAL_DOMAINS: relayB.localDomain,
    AIMTP_RELAY_PUBLIC_KEY: relayB.keys.publicKeySpkiBase64,
    AIMTP_RELAY_PRIVATE_KEY: relayB.keys.privateKeyPkcs8Base64,
    AIMTP_TRUSTED_RELAYS_PATH: trustBPath,
    AIMTP_ALLOWED_RECIPIENTS: RECIPIENT
  });

  await waitForHealth(relayA.endpoint, "A");
  await waitForHealth(relayB.endpoint, "B");
  logLine("Both relays are healthy");

  const descriptorARes = await requestJson("GET", `${relayA.endpoint}/.well-known/aimtp-relay.json`);
  assert.strictEqual(descriptorARes.status, 200, "Relay A descriptor endpoint must return 200");
  if (!descriptorARes.json || !descriptorARes.json.signature || !descriptorARes.json.signature.sig) {
    fail("Relay A descriptor missing signature fields", descriptorARes.raw);
  }
  const verifyA = verifyRelayDescriptor(
    descriptorARes.json,
    {
      relay_id: relayA.relayId,
      endpoint: relayA.endpoint,
      public_key: relayA.keys.publicKeySpkiBase64,
      alg: "ed25519"
    },
    { clockSkewSec: 30 }
  );
  if (!verifyA.ok) {
    fail("Relay A descriptor signature verification failed", JSON.stringify(verifyA));
  }

  const descriptorBRes = await requestJson("GET", `${relayB.endpoint}/.well-known/aimtp-relay.json`);
  assert.strictEqual(descriptorBRes.status, 200, "Relay B descriptor endpoint must return 200");
  if (!descriptorBRes.json || !descriptorBRes.json.signature || !descriptorBRes.json.signature.sig) {
    fail("Relay B descriptor missing signature fields", descriptorBRes.raw);
  }
  const verifyB = verifyRelayDescriptor(
    descriptorBRes.json,
    {
      relay_id: relayB.relayId,
      endpoint: relayB.endpoint,
      public_key: relayB.keys.publicKeySpkiBase64,
      alg: "ed25519"
    },
    { clockSkewSec: 30 }
  );
  if (!verifyB.ok) {
    fail("Relay B descriptor signature verification failed", JSON.stringify(verifyB));
  }
  logLine("Descriptor checks passed for both relays");

  const envelopeId = `smoke-fed-${Date.now()}`;
  const envelope = {
    spec: "aimtp/0.1",
    id: envelopeId,
    timestamp: nowIso(),
    sender: "agent@a.test",
    recipient: RECIPIENT,
    intent: "task.request",
    message: {
      id: `msg-${envelopeId}`,
      role: "user",
      content: "hello from relay A"
    }
  };

  const sendRes = await requestJson(
    "POST",
    `${relayA.endpoint}/aimtp`,
    envelope,
    { "X-AIMTP-KEY": API_KEY }
  );
  if (sendRes.status !== 202) {
    fail("Relay A send failed", `${sendRes.status} ${sendRes.raw}`);
  }

  const pollRes = await requestJson(
    "GET",
    `${relayB.endpoint}/aimtp/poll?recipient=${encodeURIComponent(RECIPIENT)}&max=1`,
    undefined,
    { "X-AIMTP-KEY": API_KEY }
  );
  if (pollRes.status !== 200 || !Array.isArray(pollRes.json) || pollRes.json.length === 0) {
    fail("Relay B did not return a federated message via poll", `${pollRes.status} ${pollRes.raw}`);
  }

  const receivedItem = pollRes.json[0];
  if (!receivedItem || !receivedItem.envelope || receivedItem.envelope.id !== envelopeId) {
    fail(
      "Relay B polled message does not match sent envelope",
      JSON.stringify(receivedItem || null)
    );
  }

  const ackRes = await requestJson(
    "POST",
    `${relayB.endpoint}/aimtp/ack`,
    {
      recipient: RECIPIENT,
      lease_id: receivedItem.lease_id
    },
    { "X-AIMTP-KEY": API_KEY }
  );
  if (ackRes.status !== 200) {
    fail("Relay B ack failed", `${ackRes.status} ${ackRes.raw}`);
  }

  const inboundVerifySeen = await waitForEvent(
    relayBProc.logs,
    "federation_inbound_verify",
    (entry) => entry.src_relay_id === relayA.relayId && entry.outcome === "ok",
    3000
  );

  if (!inboundVerifySeen) {
    fail(
      "Relay B did not emit successful federation_inbound_verify event",
      relayBProc.logs.map((item) => item.line).join("\n")
    );
  }

  logLine("PASS: federation smoke test succeeded");
}

async function main() {
  let exitCode = 0;
  try {
    await run();
  } catch (err) {
    exitCode = 1;
    const message = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
    process.stderr.write(`${message}\n`);
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

main();
