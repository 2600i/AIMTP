#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const protocolVersion = process.env.INTENTOS_PROTOCOL_VERSION;
const federationMode = process.env.INTENTOS_FEDERATION;
const shouldRunHandshake = protocolVersion === "0.4" && federationMode === "on";

if (!shouldRunHandshake) {
  console.log("HANDSHAKE SKIPPED");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDir, "../spec/federation-handshake-v0.4.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateHandshake = ajv.compile(schema);

const now = new Date().toISOString();
const hello = {
  type: "HandshakeHello",
  protocolVersion: "0.4",
  helloId: "hello-local-1",
  senderPeerId: "peer-alpha",
  recipientPeerId: "peer-beta",
  nonce: "nonce-local-1",
  timestamp: now
};

const ack = {
  type: "HandshakeAck",
  protocolVersion: "0.4",
  helloId: hello.helloId,
  senderPeerId: "peer-beta",
  recipientPeerId: "peer-alpha",
  accepted: true,
  timestamp: new Date().toISOString()
};

function assertValidHandshakeMessage(message) {
  if (!validateHandshake(message)) {
    const reasons = (validateHandshake.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
      .join("; ");
    throw new Error(`Invalid handshake payload: ${reasons}`);
  }
}

assertValidHandshakeMessage(hello);
assertValidHandshakeMessage(ack);

if (ack.helloId !== hello.helloId || ack.accepted !== true) {
  throw new Error("Handshake ack failed transcript checks.");
}

console.log("HANDSHAKE OK");
