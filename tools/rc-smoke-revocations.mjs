#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

class LoopbackUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoopbackUnavailableError";
  }
}

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return path.resolve(dirnameFromImportMeta(), "..");
}

function parseArgs(argv) {
  const options = {
    dir: path.join(os.tmpdir(), `aimtp-rc-smoke-revocations-${process.pid}`)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --dir");
      }
      options.dir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function summarize(results, demoDir) {
  console.log("\nRevocation smoke summary");
  for (const result of results) {
    const prefix = result.ok ? "PASS" : result.skipped ? "SKIP" : "FAIL";
    const detail = result.detail ? `: ${result.detail}` : "";
    console.log(`${prefix} ${result.step}${detail}`);
  }
  console.log(`demoDir: ${demoDir}`);
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createRevocationSet({ issuer = "relay://smoke", entries }) {
  return {
    type: "revocations",
    specVersion: "0.4",
    issuer,
    issuedAt: Math.floor(Date.now() / 1000),
    revocations: entries
  };
}

function canonicalizeIdentityAnchor(anchor) {
  return Buffer.from(
    JSON.stringify({
      type: anchor.type,
      protocolVersion: anchor.protocolVersion,
      anchorId: anchor.anchorId,
      peerId: anchor.peerId,
      publicKeyPem: anchor.publicKeyPem,
      timestamp: anchor.timestamp
    }),
    "utf8"
  );
}

function createSignedInlineAnchor(peerId, suffix) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const anchor = {
    type: "IdentityAnchor",
    protocolVersion: "0.4",
    anchorId: `anchor-smoke-${suffix}`,
    peerId,
    publicKeyPem,
    timestamp: new Date().toISOString()
  };
  const signature = crypto
    .sign(null, canonicalizeIdentityAnchor(anchor), privateKey)
    .toString("base64");
  return {
    ...anchor,
    alg: "ed25519",
    kid: `${peerId}#key-${suffix}`,
    signature
  };
}

function createHandshakeHello({ helloId, senderPeerId = "peer-alpha", inlineAnchors } = {}) {
  const hello = {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: helloId || `hello-smoke-${Date.now()}`,
    senderPeerId,
    recipientPeerId: "peer-beta",
    nonce: `nonce-smoke-${Date.now()}`,
    timestamp: new Date().toISOString()
  };
  if (Array.isArray(inlineAnchors) && inlineAnchors.length > 0) {
    hello.identityAnchorsInline = inlineAnchors;
  }
  return hello;
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListen);
      reject(error);
    };
    const onListen = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function startLocalRevocationServer(routeHandlers) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = routeHandlers.get(url.pathname);
      if (!route) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("not found");
        return;
      }
      res.statusCode = route.status || 200;
      res.setHeader("content-type", route.contentType || "application/json");
      res.end(route.body);
    });
    server.once("error", (error) => {
      if (error && error.code === "EPERM") {
        reject(new LoopbackUnavailableError("loopback listen denied (EPERM)"));
        return;
      }
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function sendHandshake(port, hello) {
  const response = await fetch(`http://127.0.0.1:${port}/aimtp/intentos/federation/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hello)
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { status: response.status, body };
}

function loadRuntime() {
  const require = createRequire(import.meta.url);
  return require(path.resolve(repoRoot(), "runtime"));
}

async function withRelayServer(envOverrides, fn) {
  const runtime = loadRuntime();
  return withEnv(envOverrides, async () => {
    const relay = new runtime.WebhookRelay();
    const server = runtime.createWebhookRelayServer(relay);
    try {
      try {
        await startServer(server);
      } catch (error) {
        if (error && error.code === "EPERM") {
          throw new LoopbackUnavailableError("loopback listen denied (EPERM)");
        }
        throw error;
      }
      const address = server.address();
      assert(address && typeof address === "object", "expected relay address");
      return await fn(address.port);
    } finally {
      if (server.listening) {
        await closeServer(server);
      }
    }
  });
}

async function runPassFsPeerReject(demoDir) {
  const revocationPath = path.join(demoDir, "revocations-fs-peer.json");
  writeJson(
    revocationPath,
    createRevocationSet({
      entries: [
        {
          subject: "peer-alpha",
          kind: "peer",
          revokedAt: Math.floor(Date.now() / 1000),
          reason: "smoke_fs_peer"
        }
      ]
    })
  );

  const env = {
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_REVOCATION_POLICY: "enforce",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationPath,
    INTENTOS_TRUST_HTTP_REVOCATIONS_URL: ""
  };

  return withRelayServer(env, async (port) => {
    const hello = createHandshakeHello({ helloId: "smoke-fs-peer" });
    const result = await sendHandshake(port, hello);
    assert.equal(result.status, 400, `expected HTTP 400, got ${result.status}`);
    assert.equal(result.body && result.body.code, "handshake_peer_revoked");
    return "code=handshake_peer_revoked";
  });
}

async function runPassHttpKeyReject(demoDir) {
  const inline = createSignedInlineAnchor("peer-alpha", "http-key-revoke");
  const revocationSet = createRevocationSet({
    entries: [
      {
        subject: inline.kid,
        kind: "key",
        revokedAt: Math.floor(Date.now() / 1000),
        reason: "smoke_http_key"
      }
    ]
  });

  const routes = new Map([
    [
      "/revocations.json",
      {
        contentType: "application/json",
        body: JSON.stringify(revocationSet)
      }
    ]
  ]);

  const revocationServer = await startLocalRevocationServer(routes);
  try {
    const address = revocationServer.address();
    assert(address && typeof address === "object", "expected revocation HTTP address");
    const revocationUrl = `http://127.0.0.1:${address.port}/revocations.json`;

    const env = {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "http",
      INTENTOS_TRUST_HTTP_REVOCATIONS_URL: revocationUrl,
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: ""
    };

    return await withRelayServer(env, async (port) => {
      const hello = createHandshakeHello({
        helloId: "smoke-http-key",
        inlineAnchors: [inline]
      });
      const result = await sendHandshake(port, hello);
      assert.equal(result.status, 400, `expected HTTP 400, got ${result.status}`);
      assert.equal(result.body && result.body.code, "handshake_key_revoked");
      return "code=handshake_key_revoked";
    });
  } finally {
    await closeServer(revocationServer);
  }
}

async function runPassHttpInvalidJsonReject(demoDir) {
  const routes = new Map([
    [
      "/revocations-invalid.json",
      {
        contentType: "application/json",
        body: "{ invalid-json"
      }
    ]
  ]);
  const revocationServer = await startLocalRevocationServer(routes);
  try {
    const address = revocationServer.address();
    assert(address && typeof address === "object", "expected revocation HTTP address");
    const revocationUrl = `http://127.0.0.1:${address.port}/revocations-invalid.json`;

    const env = {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "http",
      INTENTOS_TRUST_HTTP_REVOCATIONS_URL: revocationUrl,
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: ""
    };

    return await withRelayServer(env, async (port) => {
      const hello = createHandshakeHello({ helloId: "smoke-http-invalid-json" });
      const result = await sendHandshake(port, hello);
      assert.equal(result.status, 400, `expected HTTP 400, got ${result.status}`);
      const code = String((result.body && result.body.code) || "");
      assert(
        code.includes("invalid_json") || code.includes("invalid_schema"),
        `expected invalid_json or invalid_schema-like code, got ${code || "<empty>"}`
      );
      return `code=${code}`;
    });
  } finally {
    await closeServer(revocationServer);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL args: ${message}`);
    process.exit(1);
    return;
  }

  const results = [];
  let loopbackUnavailable = false;

  const step = async (name, fn, { skippable = false } = {}) => {
    try {
      const detail = await fn();
      results.push({ step: name, ok: true, detail: detail || "" });
    } catch (error) {
      if (skippable && error instanceof LoopbackUnavailableError) {
        loopbackUnavailable = true;
        results.push({
          step: name,
          ok: false,
          skipped: true,
          detail: `${error.message}; run this smoke in docker for full HTTP coverage`
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      results.push({ step: name, ok: false, detail: message });
      summarize(results, options.dir);
      process.exit(1);
    }
  };

  await step("setup demo dir", async () => {
    fs.rmSync(options.dir, { recursive: true, force: true });
    fs.mkdirSync(options.dir, { recursive: true });
    return options.dir;
  });

  await step(
    "PASS 1 fs adapter revoked peerId -> handshake_peer_revoked",
    async () => {
      return await runPassFsPeerReject(options.dir);
    },
    { skippable: true }
  );

  if (loopbackUnavailable) {
    results.push({
      step: "PASS 2 http adapter revoked keyId -> handshake_key_revoked",
      ok: false,
      skipped: true,
      detail: "skipped due to local loopback restriction; run in docker for full coverage"
    });
    results.push({
      step: "PASS 3 http invalid JSON enforce reject",
      ok: false,
      skipped: true,
      detail: "skipped due to local loopback restriction; run in docker for full coverage"
    });
  } else {
    await step(
      "PASS 2 http adapter revoked keyId -> handshake_key_revoked",
      async () => {
        return await runPassHttpKeyReject(options.dir);
      },
      { skippable: true }
    );

    await step(
      "PASS 3 http invalid JSON enforce reject",
      async () => {
        return await runPassHttpInvalidJsonReject(options.dir);
      },
      { skippable: true }
    );
  }

  const hasHardFailure = results.some((entry) => !entry.ok && !entry.skipped);
  summarize(results, options.dir);
  if (hasHardFailure) {
    process.exit(1);
  }
}

main();
