export const REVOCATION_SET_TYPE = "revocations";
export const REVOCATION_PROTOCOL_VERSION = "0.4";

export type RevocationKind = "peer" | "key" | "anchor";

export interface RevocationEntry {
  subject: string;
  kind: RevocationKind;
  revokedAt: number;
  reason?: string;
  evidence?: string;
}

export interface RevocationSet {
  type: typeof REVOCATION_SET_TYPE;
  specVersion: typeof REVOCATION_PROTOCOL_VERSION;
  issuer: string;
  issuedAt: number;
  revocations: ReadonlyArray<RevocationEntry>;
}
