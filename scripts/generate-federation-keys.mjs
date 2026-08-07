#!/usr/bin/env node
/**
 * Generates the Ed25519 key material the local federation demos sign receipts
 * with, and renders the Compose files that carry it.
 *
 * These keys used to be committed. They were only ever demo material — three
 * throwaway relays signing receipts to each other on a laptop, trusted by
 * nothing outside those files — but a reference implementation of a trust
 * protocol should not ship private keys, and a repository that contains them
 * cannot easily say so. Now nothing key-shaped is committed: the templates
 * carry placeholders, and everything real lands in ignored files.
 *
 *   node scripts/generate-federation-keys.mjs           reuse existing keys
 *   node scripts/generate-federation-keys.mjs --force    mint a fresh set
 *   node scripts/generate-federation-keys.mjs --verify   check what is there
 *
 * Reuse is the default because the demos run as two steps — `docker compose up`
 * and then the demo tool — and the relays' keys have to match the trust maps
 * the tool verifies against. Regenerating between those two steps would leave
 * every receipt unverifiable.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = path.join(root, "runtime/federation-keys.json");
const RELAYS = ["relay://a", "relay://b", "relay://c"];

/** Which issuers each relay is configured to trust, per topology. */
const TARGETS = [
  {
    template: "docker-compose.federation.template.yml",
    output: "docker-compose.federation.local.yml",
    trust: { A: ["relay://a", "relay://b"], B: ["relay://a", "relay://b"] },
  },
  {
    template: "docker-compose.federation-3hop.template.yml",
    output: "docker-compose.federation-3hop.local.yml",
    trust: {
      A: ["relay://a", "relay://b"],
      B: ["relay://a", "relay://b", "relay://c"],
      C: ["relay://b", "relay://c"],
    },
  },
];

function mint() {
  const keys = {};
  for (const issuer of RELAYS) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    keys[issuer] = {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  }
  return keys;
}

/** A keypair is only usable if the public half actually derives from the private half. */
function verifyPair(issuer, pair) {
  const derived = crypto
    .createPublicKey(pair.privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (derived.trim() !== pair.publicKeyPem.trim()) {
    throw new Error(`${issuer}: public key does not derive from the private key`);
  }
  const message = Buffer.from(`federation-demo-selftest:${issuer}`);
  const signature = crypto.sign(null, message, crypto.createPrivateKey(pair.privateKeyPem));
  if (!crypto.verify(null, message, crypto.createPublicKey(pair.publicKeyPem), signature)) {
    throw new Error(`${issuer}: sign/verify round trip failed`);
  }
}

function load() {
  if (!fs.existsSync(KEY_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    for (const issuer of RELAYS) {
      if (!parsed[issuer]?.privateKeyPem || !parsed[issuer]?.publicKeyPem) return null;
      verifyPair(issuer, parsed[issuer]);
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * PEM is multi-line, and a YAML block scalar would have to be re-indented to
 * match wherever it is substituted. A double-quoted scalar with \n escapes
 * avoids that entirely and is what the trusted-keys value already uses.
 */
function yamlString(value) {
  return JSON.stringify(value);
}

function trustMapJson(keys, issuers) {
  const map = {};
  for (const issuer of issuers) map[issuer] = keys[issuer].publicKeyPem;
  return JSON.stringify(map);
}

function render(keys) {
  const written = [];
  for (const target of TARGETS) {
    const templatePath = path.join(root, target.template);
    if (!fs.existsSync(templatePath)) throw new Error(`Missing template: ${target.template}`);
    let out = fs.readFileSync(templatePath, "utf8");

    const substitutions = {
      __RELAY_A_PRIVATE_KEY__: yamlString(keys["relay://a"].privateKeyPem),
      __RELAY_B_PRIVATE_KEY__: yamlString(keys["relay://b"].privateKeyPem),
      __RELAY_C_PRIVATE_KEY__: yamlString(keys["relay://c"].privateKeyPem),
    };
    for (const [slot, issuers] of Object.entries(target.trust)) {
      substitutions[`__TRUSTED_KEYS_${slot}__`] = yamlString(trustMapJson(keys, issuers));
    }

    for (const [token, value] of Object.entries(substitutions)) {
      out = out.split(token).join(value);
    }

    const leftover = out.match(/__[A-Z_]+__/g);
    if (leftover) throw new Error(`${target.template}: unresolved placeholders ${[...new Set(leftover)].join(", ")}`);

    fs.writeFileSync(path.join(root, target.output), out);
    written.push(target.output);
  }
  return written;
}

function main() {
  const force = process.argv.includes("--force");
  const verifyOnly = process.argv.includes("--verify");

  const existing = load();
  if (verifyOnly) {
    if (!existing) {
      console.log("federation keys: absent or invalid — run `npm run federation:keys`");
      process.exit(1);
    }
    console.log(`federation keys: ${RELAYS.length} valid keypairs in runtime/federation-keys.json`);
    return;
  }

  const keys = !force && existing ? existing : mint();
  for (const issuer of RELAYS) verifyPair(issuer, keys[issuer]);

  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });

  const written = render(keys);
  console.log(
    `${!force && existing ? "reused" : "minted"} ${RELAYS.length} demo keypairs → runtime/federation-keys.json`,
  );
  for (const file of written) console.log(`  rendered ${file}`);
}

main();
