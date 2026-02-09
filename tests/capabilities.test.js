"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { createProof } = require("../runtime/identity");
const { evaluateCapability, validateCapDoc, verifyCapDoc } = require("../runtime/capabilities");

function keyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

function makeIdentity(id, keys, role = "agent") {
  return {
    id,
    role,
    keys: [
      {
        kid: `${id}#k1`,
        alg: "ed25519",
        public_key: keys.publicKey,
        purposes: ["assertion"]
      }
    ],
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: "2029-01-01T00:00:00Z"
  };
}

function signCapDoc(doc, privateKeyValue, kid) {
  const signed = { ...doc };
  signed.proof = createProof(signed, privateKeyValue, {
    kid,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2028-01-01T00:00:00Z"
  });
  return signed;
}

function baseCapDoc(params) {
  return {
    id: params.id,
    type: "aimtp.capability",
    issuer: params.issuer,
    subject: params.subject,
    scopes: params.scopes || [{ action: "mailbox.enqueue", resource: "mailbox:user123" }],
    constraints: params.constraints,
    delegation: params.delegation,
    issued_at: params.issued_at || "2026-01-01T00:00:00Z",
    expires_at: params.expires_at || "2028-01-01T00:00:00Z"
  };
}

function main() {
  const nowMs = Date.parse("2026-06-01T00:00:00Z");

  const issuerKeys = keyMaterial();
  const delegateKeys = keyMaterial();
  const finalKeys = keyMaterial();
  const otherKeys = keyMaterial();

  const issuerId = "did:aimtp:agent.issuer";
  const delegateId = "did:aimtp:agent.delegate";
  const finalId = "did:aimtp:agent.final";

  const issuerIdentity = makeIdentity(issuerId, issuerKeys);
  const delegateIdentity = makeIdentity(delegateId, delegateKeys);
  const finalIdentity = makeIdentity(finalId, finalKeys);
  const otherIdentity = makeIdentity("did:aimtp:agent.other", otherKeys);

  const identities = {
    [issuerId]: issuerIdentity,
    [delegateId]: delegateIdentity,
    [finalId]: finalIdentity,
    [otherIdentity.id]: otherIdentity
  };

  const singleGrant = signCapDoc(
    baseCapDoc({
      id: "cap:single-valid",
      issuer: issuerId,
      subject: finalId,
      constraints: {
        max_hops: 1,
        audience: ["did:aimtp:relay.local"]
      }
    }),
    issuerKeys.privateKey,
    `${issuerId}#k1`
  );

  const shapeResult = validateCapDoc(singleGrant, { nowMs });
  assert.strictEqual(shapeResult.ok, true, "valid CapDoc shape should pass");

  const verifyResult = verifyCapDoc(singleGrant, null, { identities, nowMs });
  assert.strictEqual(verifyResult.ok, true, "valid CapDoc signature should verify");

  const allowed = evaluateCapability(
    {
      chain: [singleGrant],
      purpose: "authorize",
      requested: { action: "mailbox.enqueue", resource: "mailbox:user123" }
    },
    {
      action: "mailbox.enqueue",
      resource: "mailbox:user123",
      subject: finalId,
      audience: "did:aimtp:relay.local",
      hops: 1
    },
    { identities, nowMs }
  );
  assert.strictEqual(allowed.allow, true, "single valid grant should authorize");
  assert.strictEqual(allowed.reason_code, "capability_authorized");

  const tampered = {
    ...singleGrant,
    scopes: [{ action: "mailbox.poll", resource: "mailbox:user123" }]
  };
  const badSigDecision = evaluateCapability(
    { chain: [tampered] },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(badSigDecision.allow, false);
  assert.strictEqual(badSigDecision.reason_code, "capdoc_proof_invalid");

  const expiredDoc = signCapDoc(
    baseCapDoc({
      id: "cap:expired",
      issuer: issuerId,
      subject: finalId,
      expires_at: "2026-01-01T00:00:00Z"
    }),
    issuerKeys.privateKey,
    `${issuerId}#k1`
  );
  const expiredDecision = evaluateCapability(
    { chain: [expiredDoc] },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(expiredDecision.allow, false);
  assert.strictEqual(expiredDecision.reason_code, "capdoc_expired");

  const noDelegationA = signCapDoc(
    baseCapDoc({
      id: "cap:no-delegation-root",
      issuer: issuerId,
      subject: delegateId,
      delegation: { allowed: false, max_depth: 0 }
    }),
    issuerKeys.privateKey,
    `${issuerId}#k1`
  );
  const noDelegationB = signCapDoc(
    baseCapDoc({
      id: "cap:no-delegation-leaf",
      issuer: delegateId,
      subject: finalId
    }),
    delegateKeys.privateKey,
    `${delegateId}#k1`
  );
  const noDelegationDecision = evaluateCapability(
    { chain: [noDelegationA, noDelegationB] },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(noDelegationDecision.allow, false);
  assert.strictEqual(noDelegationDecision.reason_code, "capability_delegation_not_allowed");

  const depthRoot = signCapDoc(
    baseCapDoc({
      id: "cap:depth-root",
      issuer: issuerId,
      subject: delegateId,
      delegation: { allowed: true, max_depth: 0 }
    }),
    issuerKeys.privateKey,
    `${issuerId}#k1`
  );
  const depthLeaf = signCapDoc(
    baseCapDoc({
      id: "cap:depth-leaf",
      issuer: delegateId,
      subject: finalId
    }),
    delegateKeys.privateKey,
    `${delegateId}#k1`
  );
  const depthDecision = evaluateCapability(
    { chain: [depthRoot, depthLeaf] },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(depthDecision.allow, false);
  assert.strictEqual(depthDecision.reason_code, "capability_delegation_depth_exceeded");

  const scopeMismatch = evaluateCapability(
    {
      chain: [
        signCapDoc(
          baseCapDoc({
            id: "cap:scope-mismatch",
            issuer: issuerId,
            subject: finalId,
            scopes: [{ action: "mailbox.poll", resource: "mailbox:user123" }]
          }),
          issuerKeys.privateKey,
          `${issuerId}#k1`
        )
      ]
    },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(scopeMismatch.allow, false);
  assert.strictEqual(scopeMismatch.reason_code, "capability_scope_mismatch");

  const audienceMismatch = evaluateCapability(
    {
      chain: [
        signCapDoc(
          baseCapDoc({
            id: "cap:audience-mismatch",
            issuer: issuerId,
            subject: finalId,
            constraints: { audience: ["did:aimtp:relay.alpha"] }
          }),
          issuerKeys.privateKey,
          `${issuerId}#k1`
        )
      ]
    },
    {
      action: "mailbox.enqueue",
      resource: "mailbox:user123",
      subject: finalId,
      audience: "did:aimtp:relay.beta"
    },
    { identities, nowMs }
  );
  assert.strictEqual(audienceMismatch.allow, false);
  assert.strictEqual(audienceMismatch.reason_code, "capability_audience_mismatch");

  const discontinuityA = signCapDoc(
    baseCapDoc({
      id: "cap:discontinuity-a",
      issuer: issuerId,
      subject: delegateId,
      delegation: { allowed: true, max_depth: 1 }
    }),
    issuerKeys.privateKey,
    `${issuerId}#k1`
  );
  const discontinuityB = signCapDoc(
    baseCapDoc({
      id: "cap:discontinuity-b",
      issuer: otherIdentity.id,
      subject: finalId
    }),
    otherKeys.privateKey,
    `${otherIdentity.id}#k1`
  );
  const discontinuityDecision = evaluateCapability(
    { chain: [discontinuityA, discontinuityB] },
    { action: "mailbox.enqueue", resource: "mailbox:user123", subject: finalId },
    { identities, nowMs }
  );
  assert.strictEqual(discontinuityDecision.allow, false);
  assert.strictEqual(discontinuityDecision.reason_code, "capability_chain_discontinuity");

  console.log("OK: capabilities tests");
}

main();
