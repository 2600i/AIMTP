"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.stableJsonStringify = stableJsonStringify;
exports.canonicalizeForSigning = canonicalizeForSigning;
exports.signDescriptor = signDescriptor;
exports.verifyDescriptor = verifyDescriptor;
exports.loadTrustPolicy = loadTrustPolicy;
exports.resolveDestinationRelayId = resolveDestinationRelayId;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stableJsonStringify(value) {
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
        return JSON.stringify(value);
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort();
        const parts = keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`);
        return `{${parts.join(",")}}`;
    }
    throw new Error(`unsupported_value_type:${typeof value}`);
}
function canonicalizeForSigning(value) {
    const payload = {};
    Object.keys(value).forEach((key) => {
        if (key === "signature") {
            return;
        }
        const entry = value[key];
        if (entry !== undefined) {
            payload[key] = entry;
        }
    });
    return Buffer.from(stableJsonStringify(payload), "utf8");
}
function parseRfc3339(value) {
    if (!value) {
        return null;
    }
    if (!RFC3339_REGEX.test(value)) {
        return Number.NaN;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        return Number.NaN;
    }
    return parsed;
}
function decodeBase64(value) {
    if (!BASE64_REGEX.test(value)) {
        return null;
    }
    try {
        return Buffer.from(value, "base64");
    }
    catch (_err) {
        return null;
    }
}
function decodeKeyMaterial(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const hexCandidate = trimmed.replace(/^0x/i, "");
    if (hexCandidate.length > 0 &&
        hexCandidate.length % 2 === 0 &&
        /^[a-fA-F0-9]+$/.test(hexCandidate)) {
        return Buffer.from(hexCandidate, "hex");
    }
    if (!BASE64_REGEX.test(trimmed)) {
        return null;
    }
    try {
        return Buffer.from(trimmed, "base64");
    }
    catch (_err) {
        return null;
    }
}
function loadPublicKey(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----BEGIN")) {
        return crypto.createPublicKey(trimmed);
    }
    const decoded = decodeKeyMaterial(trimmed);
    if (!decoded) {
        throw new Error("public_key_decode_failed");
    }
    if (decoded.length === 32) {
        return crypto.createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, decoded]),
            format: "der",
            type: "spki"
        });
    }
    return crypto.createPublicKey({ key: decoded, format: "der", type: "spki" });
}
function loadPrivateKey(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----BEGIN")) {
        return crypto.createPrivateKey(trimmed);
    }
    const decoded = decodeKeyMaterial(trimmed);
    if (!decoded) {
        throw new Error("private_key_decode_failed");
    }
    return crypto.createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
}
function signDescriptor(descriptor, privateKeyValue, kid) {
    const payload = canonicalizeForSigning(descriptor);
    const privateKey = loadPrivateKey(privateKeyValue);
    const signature = crypto.sign(null, payload, privateKey).toString("base64");
    return {
        ...descriptor,
        signature: {
            alg: "ed25519",
            kid,
            sig: signature
        }
    };
}
function verifyDescriptor(descriptor, trusted, nowMs = Date.now(), clockSkewSec = 0) {
    const issuedAt = parseRfc3339(descriptor.issued_at);
    const expiresAt = parseRfc3339(descriptor.expires_at);
    if (typeof issuedAt !== "number" ||
        !Number.isFinite(issuedAt) ||
        typeof expiresAt !== "number" ||
        !Number.isFinite(expiresAt)) {
        return false;
    }
    const trustExpiresAt = parseRfc3339(trusted.expires_at);
    const skewMs = Math.max(0, Math.floor(clockSkewSec * 1000));
    if (nowMs + skewMs < issuedAt) {
        return false;
    }
    if (nowMs - skewMs > expiresAt) {
        return false;
    }
    if (Number.isFinite(trustExpiresAt) && nowMs - skewMs > trustExpiresAt) {
        return false;
    }
    if (descriptor.relay_id !== trusted.relay_id) {
        return false;
    }
    if (descriptor.endpoint !== trusted.endpoint) {
        return false;
    }
    const signature = decodeBase64(descriptor.signature.sig);
    if (!signature) {
        return false;
    }
    const payload = canonicalizeForSigning(descriptor);
    const publicKey = loadPublicKey(trusted.public_key);
    return crypto.verify(null, payload, publicKey, signature);
}
function loadTrustPolicy(pathname) {
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.trusted_relays)) {
        throw new Error("trust_policy_invalid");
    }
    return parsed;
}
function resolveDestinationRelayId(recipient, domains) {
    const trimmed = recipient.trim();
    const atIndex = trimmed.lastIndexOf("@");
    const colonIndex = trimmed.lastIndexOf(":");
    const splitIndex = atIndex > -1 ? atIndex : colonIndex;
    if (splitIndex < 0 || splitIndex >= trimmed.length - 1) {
        return "";
    }
    const domain = trimmed.slice(splitIndex + 1).toLowerCase();
    if (domains && typeof domains[domain] === "string" && domains[domain].trim()) {
        return domains[domain].trim();
    }
    return domain;
}
