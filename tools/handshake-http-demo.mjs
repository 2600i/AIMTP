#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const protocolVersion = process.env.INTENTOS_PROTOCOL_VERSION;
const federationMode = process.env.INTENTOS_FEDERATION;
const identityMode = process.env.INTENTOS_IDENTITY;
const shouldRunHandshake =
  protocolVersion === "0.4" && federationMode === "on" && identityMode === "on";

if (!shouldRunHandshake) {
  console.log("HANDSHAKE HTTP SKIPPED");
  process.exit(0);
}

const sendAnchorsModeRaw = String(process.env.INTENTOS_HANDSHAKE_SEND_ANCHORS || "off")
  .trim()
  .toLowerCase();
const sendAnchorsMode =
  sendAnchorsModeRaw === "inline" || sendAnchorsModeRaw === "setid"
    ? sendAnchorsModeRaw
    : "off";
const handshakeNegotiationMode =
  String(process.env.INTENTOS_HANDSHAKE_NEGOTIATION || "off").trim().toLowerCase() === "on"
    ? "on"
    : "off";
const handshakePeerVerifyMode = String(process.env.INTENTOS_HANDSHAKE_PEER_VERIFY || "off")
  .trim()
  .toLowerCase();
const negotiationEnabled =
  protocolVersion === "0.4" &&
  federationMode === "on" &&
  handshakeNegotiationMode === "on";

const require = createRequire(import.meta.url);
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const handshakeSchemaPath = path.resolve(scriptDir, "../spec/federation-handshake-v0.4.schema.json");
const handshakeSchema = JSON.parse(fs.readFileSync(handshakeSchemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateHandshake = ajv.compile(handshakeSchema);

function assertValidHandshakeMessage(message) {
  if (!validateHandshake(message)) {
    const reasons = (validateHandshake.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
      .join("; ");
    throw new Error(`Invalid handshake payload: ${reasons}`);
  }
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

function canonicalizeHandshakePeerProofPayload(hello) {
  const capabilitiesOffered = canonicalizeCapabilityList(hello.capabilitiesOffered);
  const capabilitiesRequired = canonicalizeCapabilityList(hello.capabilitiesRequired);
  return Buffer.from(
    JSON.stringify({
      nonce: hello.nonce,
      timestamp: hello.timestamp,
      senderPeerId: hello.senderPeerId,
      senderRelayUrl: hello.senderRelayUrl || "",
      capabilitiesOffered,
      capabilitiesRequired
    }),
    "utf8"
  );
}

function canonicalizeCapabilityList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function createSignedIdentityAnchor(suffix = "1") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const anchor = {
    type: "IdentityAnchor",
    protocolVersion: "0.4",
    anchorId: `anchor-http-${suffix}`,
    peerId: "peer-alpha",
    publicKeyPem,
    timestamp: new Date().toISOString()
  };
  const signature = crypto
    .sign(null, canonicalizeIdentityAnchor(anchor), privateKey)
    .toString("base64");
  return {
    anchor: {
      ...anchor,
      alg: "ed25519",
      kid: `peer-alpha#key-${suffix}`,
      signature
    },
    privateKey
  };
}

function createPeerProof(hello, privateKey, keyId) {
  return {
    keyId,
    nonce: hello.nonce,
    signature: crypto.sign(null, canonicalizeHandshakePeerProofPayload(hello), privateKey).toString("base64")
  };
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

function withTempAnchorSet() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-handshake-anchor-set-"));
  const setId = `set-http-${Date.now()}`;
  const anchorSetPath = path.join(tempDir, "identity-anchors.json");
  const proofSource = createSignedIdentityAnchor("set");
  const anchorSet = {
    type: "identity-anchors",
    protocolVersion: "0.4",
    setId,
    anchors: [proofSource.anchor]
  };
  fs.writeFileSync(anchorSetPath, `${JSON.stringify(anchorSet, null, 2)}\n`, "utf8");
  return { tempDir, setId, anchorSetPath, proofSource };
}

function getLocalHandshakeCapabilities() {
  const capabilities = ["federation-handshake-http"];
  if (identityMode === "on") {
    capabilities.push("identity-anchor-exchange");
  }
  if (handshakePeerVerifyMode !== "off") {
    capabilities.push("peer-proof");
  }
  if (negotiationEnabled) {
    capabilities.push("capability-negotiation");
  }
  return canonicalizeCapabilityList(capabilities);
}

function computeIntersection(left, right) {
  const rightSet = new Set(canonicalizeCapabilityList(right));
  return canonicalizeCapabilityList(canonicalizeCapabilityList(left).filter((entry) => rightSet.has(entry)));
}

const previousEnv = {
  INTENTOS_TRUST_DISTRIBUTION: process.env.INTENTOS_TRUST_DISTRIBUTION,
  INTENTOS_TRUST_IDENTITY_ANCHORS_PATH: process.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH,
  INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL: process.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL
};

let tempAnchorSet = null;
let peerProofSource = null;

const relay = new WebhookRelay();
const server = createWebhookRelayServer(relay);

try {
  const hello = {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: `hello-http-${Date.now()}`,
    senderPeerId: "peer-alpha",
    recipientPeerId: "peer-beta",
    nonce: `nonce-http-${Date.now()}`,
    timestamp: new Date().toISOString()
  };

  const localHandshakeCapabilities = getLocalHandshakeCapabilities();
  if (negotiationEnabled) {
    hello.capabilitiesOffered = canonicalizeCapabilityList([
      "identity-anchor-exchange",
      "federation-handshake-http",
      "capability-demo-extra"
    ]);
    hello.capabilitiesRequired = canonicalizeCapabilityList(["federation-handshake-http"]);
  }

  if (sendAnchorsMode === "inline") {
    peerProofSource = createSignedIdentityAnchor("inline");
    hello.identityAnchorsInline = [peerProofSource.anchor];
  } else if (sendAnchorsMode === "setid") {
    tempAnchorSet = withTempAnchorSet();
    hello.identityAnchorSetId = tempAnchorSet.setId;
    peerProofSource = tempAnchorSet.proofSource;
    process.env.INTENTOS_TRUST_DISTRIBUTION = "fs";
    process.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH = tempAnchorSet.anchorSetPath;
    delete process.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL;
  }
  if (peerProofSource) {
    hello.peerProof = createPeerProof(
      hello,
      peerProofSource.privateKey,
      peerProofSource.anchor.anchorId
    );
  }

  assertValidHandshakeMessage(hello);

  await startServer(server);
  const address = server.address();
  assert(address && typeof address === "object", "Expected server address");

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
  if (negotiationEnabled) {
    const expectedAccepted = computeIntersection(hello.capabilitiesOffered, localHandshakeCapabilities);
    if (JSON.stringify(ack.capabilitiesAccepted || []) !== JSON.stringify(expectedAccepted)) {
      throw new Error("Handshake ack capabilitiesAccepted mismatch.");
    }
    if (JSON.stringify(ack.capabilitiesMissing || []) !== JSON.stringify([])) {
      throw new Error("Handshake ack capabilitiesMissing mismatch.");
    }
  }

  if (negotiationEnabled) {
    const missingHello = {
      type: "HandshakeHello",
      protocolVersion: "0.4",
      helloId: `hello-http-missing-${Date.now()}`,
      senderPeerId: "peer-alpha",
      recipientPeerId: "peer-beta",
      nonce: `nonce-http-missing-${Date.now()}`,
      timestamp: new Date().toISOString(),
      capabilitiesOffered: canonicalizeCapabilityList(["federation-handshake-http"]),
      capabilitiesRequired: canonicalizeCapabilityList(["unsupported-capability-demo"])
    };
    assertValidHandshakeMessage(missingHello);
    const missingResponse = await fetch(
      `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(missingHello)
      }
    );
    if (missingResponse.status !== 400) {
      throw new Error(`Expected negotiation missing failure 400, got ${missingResponse.status}`);
    }
    const missingBody = await missingResponse.json();
    const missingList = canonicalizeCapabilityList(
      missingBody && missingBody.details && missingBody.details.capabilitiesMissing
    );
    if (JSON.stringify(missingList) !== JSON.stringify(["unsupported-capability-demo"])) {
      throw new Error("Negotiation missing capability list mismatch.");
    }
    console.log("CAPABILITY NEGOTIATION OK");
  }

  if (sendAnchorsMode === "inline" || sendAnchorsMode === "setid") {
    if (ack.acceptedIdentityAnchors !== true) {
      throw new Error("Handshake identity anchor exchange was not accepted.");
    }
    if (sendAnchorsMode === "setid" && ack.resolvedAnchorSetId !== hello.identityAnchorSetId) {
      throw new Error("Resolved anchor set id mismatch.");
    }
    console.log("ANCHOR EXCHANGE OK");
  } else {
    console.log("HANDSHAKE HTTP OK");
  }
} finally {
  if (server.listening) {
    await closeServer(server);
  }
  if (previousEnv.INTENTOS_TRUST_DISTRIBUTION === undefined) {
    delete process.env.INTENTOS_TRUST_DISTRIBUTION;
  } else {
    process.env.INTENTOS_TRUST_DISTRIBUTION = previousEnv.INTENTOS_TRUST_DISTRIBUTION;
  }
  if (previousEnv.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH === undefined) {
    delete process.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH;
  } else {
    process.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH = previousEnv.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH;
  }
  if (previousEnv.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL === undefined) {
    delete process.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL;
  } else {
    process.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL = previousEnv.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL;
  }
  if (tempAnchorSet) {
    fs.rmSync(tempAnchorSet.tempDir, { recursive: true, force: true });
  }
}
