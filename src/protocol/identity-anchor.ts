export const IDENTITY_ANCHOR_TYPE = "IdentityAnchor";
export const ANCHOR_PROOF_TYPE = "AnchorProof";
export const IDENTITY_PROTOCOL_VERSION = "0.4";

export interface IdentityAnchor {
  type: typeof IDENTITY_ANCHOR_TYPE;
  protocolVersion: typeof IDENTITY_PROTOCOL_VERSION;
  anchorId: string;
  peerId: string;
  publicKeyPem: string;
  timestamp: string;
}

export interface AnchorProof {
  type: typeof ANCHOR_PROOF_TYPE;
  protocolVersion: typeof IDENTITY_PROTOCOL_VERSION;
  anchorId: string;
  alg: "ed25519";
  kid: string;
  signature: string;
  timestamp: string;
}
