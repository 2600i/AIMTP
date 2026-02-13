export const HANDSHAKE_HELLO_TYPE = "HandshakeHello";
export const HANDSHAKE_ACK_TYPE = "HandshakeAck";
export const HANDSHAKE_PROTOCOL_VERSION = "0.4";

export interface FederationHandshakeHello {
  type: typeof HANDSHAKE_HELLO_TYPE;
  protocolVersion: typeof HANDSHAKE_PROTOCOL_VERSION;
  helloId: string;
  senderPeerId: string;
  recipientPeerId: string;
  nonce: string;
  timestamp: string;
}

export interface FederationHandshakeAck {
  type: typeof HANDSHAKE_ACK_TYPE;
  protocolVersion: typeof HANDSHAKE_PROTOCOL_VERSION;
  helloId: string;
  senderPeerId: string;
  recipientPeerId: string;
  accepted: boolean;
  timestamp: string;
}

export type FederationHandshakeMessage = FederationHandshakeHello | FederationHandshakeAck;

export type HandshakeHello = FederationHandshakeHello;
export type HandshakeAck = FederationHandshakeAck;
