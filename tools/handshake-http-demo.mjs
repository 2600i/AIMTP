#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const protocolVersion = process.env.INTENTOS_PROTOCOL_VERSION;
const federationMode = process.env.INTENTOS_FEDERATION;
const shouldRunHandshake = protocolVersion === "0.4" && federationMode === "on";

if (!shouldRunHandshake) {
  console.log("HANDSHAKE HTTP SKIPPED");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDir, "../spec/federation-handshake-v0.4.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateHandshake = ajv.compile(schema);

function assertValidHandshakeMessage(message) {
  if (!validateHandshake(message)) {
    const reasons = (validateHandshake.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
      .join("; ");
    throw new Error(`Invalid handshake payload: ${reasons}`);
  }
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

const relay = new WebhookRelay();
const server = createWebhookRelayServer(relay);

try {
  await startServer(server);
  const address = server.address();
  assert(address && typeof address === "object", "Expected server address");

  const hello = {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: `hello-http-${Date.now()}`,
    senderPeerId: "peer-alpha",
    recipientPeerId: "peer-beta",
    nonce: `nonce-http-${Date.now()}`,
    timestamp: new Date().toISOString()
  };
  assertValidHandshakeMessage(hello);

  const response = await fetch(
    `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hello)
    }
  );

  if (!response.ok) {
    throw new Error(`Handshake endpoint failed: http_status_${response.status}`);
  }

  const ack = await response.json();
  assertValidHandshakeMessage(ack);
  if (ack.type !== "HandshakeAck") {
    throw new Error("Handshake response type mismatch.");
  }
  if (ack.helloId !== hello.helloId) {
    throw new Error("Handshake ack helloId mismatch.");
  }
  if (ack.nonce !== hello.nonce) {
    throw new Error("Handshake ack nonce mismatch.");
  }
  if (ack.helloTimestamp !== hello.timestamp) {
    throw new Error("Handshake ack timestamp echo mismatch.");
  }

  console.log("HANDSHAKE HTTP OK");
} finally {
  if (server.listening) {
    await closeServer(server);
  }
}
