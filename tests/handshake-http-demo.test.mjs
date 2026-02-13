#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "handshake-http-demo.mjs");
const require = createRequire(import.meta.url);
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

function runHandshakeHttpTool(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
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

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function testDefaultEnvironmentSkipsHandshakeHttpDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "",
    INTENTOS_FEDERATION: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE HTTP SKIPPED/);
}

function testEnabledEnvironmentRunsHandshakeHttpDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE HTTP OK/);
}

async function testEndpointReturns404WhenNotGated() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "",
      INTENTOS_FEDERATION: ""
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-404",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-404",
          timestamp: new Date().toISOString()
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 404, `expected 404, got ${response.status}`);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function main() {
  testDefaultEnvironmentSkipsHandshakeHttpDemo();
  testEnabledEnvironmentRunsHandshakeHttpDemo();
  await testEndpointReturns404WhenNotGated();
  console.log("OK: handshake HTTP demo tests");
}

main();
