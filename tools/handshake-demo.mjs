#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const protocolVersion = process.env.INTENTOS_PROTOCOL_VERSION;
const federationMode = process.env.INTENTOS_FEDERATION;
const shouldRunHandshake = protocolVersion === "0.4" && federationMode === "on";
const revocationPolicyModeRaw = String(process.env.INTENTOS_REVOCATION_POLICY || "off")
  .trim()
  .toLowerCase();
const revocationPolicyMode =
  revocationPolicyModeRaw === "warn" || revocationPolicyModeRaw === "enforce"
    ? revocationPolicyModeRaw
    : "off";
const revocationMode = String(process.env.INTENTOS_REVOCATIONS || "off").trim().toLowerCase();
const revocationCaseRaw = String(process.env.INTENTOS_HANDSHAKE_REVOCATION_CASE || "off")
  .trim()
  .toLowerCase();
const revocationCase =
  revocationCaseRaw === "peer" || revocationCaseRaw === "key" || revocationCaseRaw === "anchor"
    ? revocationCaseRaw
    : "off";

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

if (revocationCase === "key" || revocationCase === "anchor") {
  hello.identityAnchorsInline = [
    {
      type: "IdentityAnchor",
      protocolVersion: "0.4",
      anchorId: "anchor-local-demo",
      peerId: hello.senderPeerId,
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\\nlocal-demo\\n-----END PUBLIC KEY-----\\n",
      timestamp: now,
      kid: "peer-alpha#key-local"
    }
  ];
  hello.peerProof = {
    keyId: "peer-alpha#key-local",
    nonce: hello.nonce,
    signature: "demo-signature"
  };
}

const ack = {
  type: "HandshakeAck",
  protocolVersion: "0.4",
  helloId: hello.helloId,
  senderPeerId: "peer-beta",
  recipientPeerId: "peer-alpha",
  nonce: hello.nonce,
  helloTimestamp: hello.timestamp,
  accepted: true,
  acceptedIdentityAnchors: false,
  resolvedAnchorSetId: null,
  capabilitiesAccepted: [],
  capabilitiesMissing: [],
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

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeTrustDistributionMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "fs" || normalized === "http" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function computeIdentityAnchorFingerprint(publicKeyPem) {
  return `sha256:${crypto.createHash("sha256").update(publicKeyPem, "utf8").digest("hex")}`;
}

function buildRevocationValidator() {
  const revocationSchemaPath = path.resolve(scriptDir, "../spec/revocation-set-v0.4.schema.json");
  const revocationSchema = JSON.parse(fs.readFileSync(revocationSchemaPath, "utf8"));
  const revocationAjv = new Ajv({ allErrors: true, strict: false });
  return revocationAjv.compile(revocationSchema);
}

async function fetchJsonFromHttp(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("handshake_demo_revocation_url_invalid");
  }
  const response = await fetch(parsed, {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`handshake_demo_revocation_http_status_${response.status}`);
  }
  return await response.text();
}

async function loadRevocationEntries() {
  const mode = normalizeTrustDistributionMode(process.env.INTENTOS_TRUST_DISTRIBUTION);
  if (mode !== "fs" && mode !== "http") {
    return [];
  }
  let raw = "";
  if (mode === "fs") {
    const revocationPath = normalizeNonEmptyString(process.env.INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH);
    if (!revocationPath) {
      return [];
    }
    raw = fs.readFileSync(revocationPath, "utf8");
  } else {
    const revocationUrl = normalizeNonEmptyString(process.env.INTENTOS_TRUST_HTTP_REVOCATIONS_URL);
    if (!revocationUrl) {
      return [];
    }
    raw = await fetchJsonFromHttp(revocationUrl);
  }
  const parsed = JSON.parse(raw);
  const validateRevocations = buildRevocationValidator();
  if (!validateRevocations(parsed)) {
    const reasons = (validateRevocations.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
      .join("; ");
    throw new Error(`handshake_demo_revocation_schema_invalid:${reasons}`);
  }
  return Array.isArray(parsed.revocations) ? parsed.revocations : [];
}

function findRevocationMatch(revocations, kind, subjects) {
  const subjectSet = new Set(
    (Array.isArray(subjects) ? subjects : [])
      .map((entry) => normalizeNonEmptyString(entry))
      .filter((entry) => entry.length > 0)
  );
  if (subjectSet.size === 0) {
    return null;
  }
  const matches = (Array.isArray(revocations) ? revocations : [])
    .filter((entry) => entry && normalizeNonEmptyString(entry.kind) === kind)
    .filter((entry) => subjectSet.has(normalizeNonEmptyString(entry.subject)))
    .map((entry) => ({
      subject: normalizeNonEmptyString(entry.subject),
      kind: normalizeNonEmptyString(entry.kind),
      revokedAt: Number.isFinite(entry.revokedAt) ? entry.revokedAt : Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => {
      if (left.revokedAt !== right.revokedAt) {
        return left.revokedAt - right.revokedAt;
      }
      return left.subject.localeCompare(right.subject);
    });
  return matches[0] || null;
}

assertValidHandshakeMessage(hello);
assertValidHandshakeMessage(ack);

if (
  ack.helloId !== hello.helloId ||
  ack.nonce !== hello.nonce ||
  ack.helloTimestamp !== hello.timestamp ||
  ack.accepted !== true
) {
  throw new Error("Handshake ack failed transcript checks.");
}

if (
  protocolVersion === "0.4" &&
  federationMode === "on" &&
  revocationMode === "on" &&
  revocationPolicyMode !== "off"
) {
  const revocations = await loadRevocationEntries();
  const anchor = Array.isArray(hello.identityAnchorsInline) ? hello.identityAnchorsInline[0] : null;
  const peerMatch = findRevocationMatch(revocations, "peer", [hello.senderPeerId]);
  const keyMatch = findRevocationMatch(revocations, "key", [
    hello.peerProof && hello.peerProof.keyId,
    anchor && anchor.kid
  ]);
  const anchorMatch = findRevocationMatch(revocations, "anchor", [
    anchor && anchor.anchorId,
    anchor && anchor.publicKeyPem ? computeIdentityAnchorFingerprint(anchor.publicKeyPem) : ""
  ]);
  const match =
    revocationCase === "peer"
      ? peerMatch
      : revocationCase === "key"
        ? keyMatch
        : revocationCase === "anchor"
          ? anchorMatch
          : peerMatch || keyMatch || anchorMatch;
  if (match) {
    const code =
      match.kind === "peer"
        ? "handshake_peer_revoked"
        : match.kind === "key"
          ? "handshake_key_revoked"
          : "anchor_revoked";
    if (revocationPolicyMode === "enforce") {
      throw new Error(`${code}:${match.subject}`);
    }
    console.warn(
      JSON.stringify({
        event: "handshake_revocation_warning",
        mode: "warn",
        code,
        subject: match.subject
      })
    );
    console.log("REVOCATION WARN ALLOW OK");
  }
}

console.log("HANDSHAKE OK");
