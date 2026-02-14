export const HANDSHAKE_HELLO_TYPE = "HandshakeHello";
export const HANDSHAKE_ACK_TYPE = "HandshakeAck";
export const HANDSHAKE_PROTOCOL_VERSION = "0.4";

export interface FederationHandshakePeerProof {
  keyId: string;
  nonce: string;
  signature: string;
}

export interface FederationHandshakeHello {
  type: typeof HANDSHAKE_HELLO_TYPE;
  protocolVersion: typeof HANDSHAKE_PROTOCOL_VERSION;
  helloId: string;
  senderPeerId: string;
  recipientPeerId: string;
  nonce: string;
  timestamp: string;
  capabilitiesOffered?: ReadonlyArray<string>;
  capabilitiesRequired?: ReadonlyArray<string>;
  peerProof?: FederationHandshakePeerProof;
  identityAnchorSetId?: string;
  identityAnchorsInline?: ReadonlyArray<{
    type: "IdentityAnchor";
    protocolVersion: "0.4";
    anchorId: string;
    peerId: string;
    publicKeyPem: string;
    timestamp: string;
    alg?: "ed25519";
    kid?: string;
    signature?: string;
  }>;
}

export interface FederationHandshakeAck {
  type: typeof HANDSHAKE_ACK_TYPE;
  protocolVersion: typeof HANDSHAKE_PROTOCOL_VERSION;
  helloId: string;
  senderPeerId: string;
  recipientPeerId: string;
  nonce: string;
  helloTimestamp: string;
  accepted: boolean;
  acceptedIdentityAnchors: boolean;
  resolvedAnchorSetId: string | null;
  capabilitiesAccepted: ReadonlyArray<string>;
  capabilitiesMissing: ReadonlyArray<string>;
  timestamp: string;
}

export type FederationHandshakeMessage = FederationHandshakeHello | FederationHandshakeAck;

export type HandshakeHello = FederationHandshakeHello;
export type HandshakeAck = FederationHandshakeAck;
