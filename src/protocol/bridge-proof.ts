import Ajv, { type ErrorObject } from "ajv";
import { createHash, createPrivateKey, sign } from "node:crypto";

export const BRIDGE_PROOF_VERSION = "v1";
export const BRIDGE_PROOF_SIGNATURE_ALG = "ed25519";

export interface BridgeProofPayload {
  readonly version: typeof BRIDGE_PROOF_VERSION;
  readonly issuer: string;
  readonly subject: string;
  readonly subjectPublicKeyPem: string;
  readonly subjectKeyFingerprint?: string;
  readonly subjectKeyKid?: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sigAlg: typeof BRIDGE_PROOF_SIGNATURE_ALG;
}

export interface BridgeProof extends BridgeProofPayload {
  readonly signature: string;
}

export interface BridgeProofSchemaValidationResult {
  readonly valid: boolean;
  readonly error: string | null;
}

export interface CreateBridgeProofOptions {
  readonly issuer: string;
  readonly subject: string;
  readonly subjectPublicKeyPem: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly subjectKeyFingerprint?: string;
  readonly subjectKeyKid?: string;
}

export const BRIDGE_PROOF_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://aimtp.dev/schemas/bridge-proof-v1.schema.json",
  title: "AIMTP Bridge Proof v1",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "issuer",
    "subject",
    "subjectPublicKeyPem",
    "issuedAt",
    "expiresAt",
    "sigAlg",
    "signature"
  ],
  properties: {
    version: { const: BRIDGE_PROOF_VERSION },
    issuer: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    subjectPublicKeyPem: { type: "string", minLength: 1 },
    subjectKeyFingerprint: { type: "string", minLength: 1 },
    subjectKeyKid: { type: "string", minLength: 1 },
    issuedAt: { type: "integer", minimum: 0 },
    expiresAt: { type: "integer", minimum: 0 },
    sigAlg: { const: BRIDGE_PROOF_SIGNATURE_ALG },
    signature: {
      type: "string",
      pattern: "^[A-Za-z0-9+/]+={0,2}$"
    }
  },
  anyOf: [
    { required: ["subjectKeyFingerprint"] },
    { required: ["subjectKeyKid"] }
  ]
});

const bridgeProofAjv = new Ajv({ allErrors: true, strict: false });
const validateBridgeProofSchemaFn = bridgeProofAjv.compile(BRIDGE_PROOF_SCHEMA);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringifyJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non_finite_number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  const first = errors[0];
  const location = first.instancePath || "/";
  const message = first.message || "invalid";
  return `${location} ${message}`.trim();
}

export function computeBridgeProofSubjectFingerprint(subjectPublicKeyPem: string): string {
  const normalizedPem = subjectPublicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

export function canonicalizeBridgeProofPayload(payload: BridgeProofPayload): Buffer {
  return Buffer.from(
    stableStringifyJson({
      version: payload.version,
      issuer: payload.issuer,
      subject: payload.subject,
      subjectPublicKeyPem: payload.subjectPublicKeyPem,
      subjectKeyFingerprint: payload.subjectKeyFingerprint,
      subjectKeyKid: payload.subjectKeyKid,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      sigAlg: payload.sigAlg
    }),
    "utf8"
  );
}

export function validateBridgeProofSchema(value: unknown): BridgeProofSchemaValidationResult {
  const valid = validateBridgeProofSchemaFn(value);
  if (valid) {
    return { valid: true, error: null };
  }
  return {
    valid: false,
    error: formatValidationErrors(validateBridgeProofSchemaFn.errors)
  };
}

export function createBridgeProof(
  options: CreateBridgeProofOptions,
  issuerPrivateKeyPem: string
): BridgeProof {
  const subjectKeyFingerprint = options.subjectKeyFingerprint || computeBridgeProofSubjectFingerprint(
    options.subjectPublicKeyPem
  );
  const payload: BridgeProofPayload = {
    version: BRIDGE_PROOF_VERSION,
    issuer: options.issuer,
    subject: options.subject,
    subjectPublicKeyPem: options.subjectPublicKeyPem,
    subjectKeyFingerprint,
    ...(options.subjectKeyKid ? { subjectKeyKid: options.subjectKeyKid } : {}),
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    sigAlg: BRIDGE_PROOF_SIGNATURE_ALG
  };
  const signature = sign(
    null,
    canonicalizeBridgeProofPayload(payload),
    createPrivateKey(issuerPrivateKeyPem)
  ).toString("base64");

  return Object.freeze({
    ...payload,
    signature
  });
}
