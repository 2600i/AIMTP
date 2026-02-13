#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const protocolVersion = process.env.INTENTOS_PROTOCOL_VERSION;
const identityMode = process.env.INTENTOS_IDENTITY;
const shouldRunAnchor = protocolVersion === "0.4" && identityMode === "on";

if (!shouldRunAnchor) {
  console.log("ANCHOR SKIPPED");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDir, "../spec/identity-anchor-v0.4.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePayload = ajv.compile(schema);

function assertValidPayload(payload) {
  if (!validatePayload(payload)) {
    const reasons = (validatePayload.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
      .join("; ");
    throw new Error(`Invalid anchor payload: ${reasons}`);
  }
}

function canonicalizeAnchor(anchor) {
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

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const anchor = {
  type: "IdentityAnchor",
  protocolVersion: "0.4",
  anchorId: "anchor-local-1",
  peerId: "peer-alpha",
  publicKeyPem,
  timestamp: new Date().toISOString()
};

const signatureBuffer = crypto.sign(null, canonicalizeAnchor(anchor), privateKey);

const proof = {
  type: "AnchorProof",
  protocolVersion: "0.4",
  anchorId: anchor.anchorId,
  alg: "ed25519",
  kid: "peer-alpha#key-1",
  signature: signatureBuffer.toString("base64"),
  timestamp: new Date().toISOString()
};

assertValidPayload(anchor);
assertValidPayload(proof);

const verified = crypto.verify(null, canonicalizeAnchor(anchor), publicKey, Buffer.from(proof.signature, "base64"));
if (!verified) {
  throw new Error("Anchor proof verification failed.");
}

console.log("ANCHOR OK");
