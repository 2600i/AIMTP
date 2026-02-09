export type IdentityRole = "relay" | "agent" | "service";

export interface IdentityKey {
  kid: string;
  alg: "ed25519";
  public_key: string;
  purposes?: string[];
}

export interface IdentityDocument {
  id: string;
  role: IdentityRole;
  keys: IdentityKey[];
  issued_at?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Proof {
  type?: string;
  alg: "ed25519";
  kid: string;
  sig: string;
  created_at?: string;
  expires_at?: string;
}

export interface VerifyResult {
  ok: boolean;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
