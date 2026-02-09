export interface Signature {
    alg: "ed25519";
    kid: string;
    sig: string;
}
export interface RelayDescriptor {
    relay_id: string;
    endpoint: string;
    alg: "ed25519";
    public_key: string;
    issued_at: string;
    expires_at: string;
    signature: Signature;
}
export interface TrustedRelayEntry {
    relay_id: string;
    endpoint: string;
    public_key: string;
    alg: "ed25519";
    expires_at?: string;
}
export interface TrustPolicy {
    trusted_relays: TrustedRelayEntry[];
    domains?: Record<string, string>;
}
export interface FederatedEnvelope {
    descriptor: RelayDescriptor;
    envelope: Record<string, unknown>;
}
export declare function stableJsonStringify(value: unknown): string;
export declare function canonicalizeForSigning(value: Record<string, unknown>): Buffer;
export declare function signDescriptor(descriptor: Omit<RelayDescriptor, "signature">, privateKeyValue: string, kid: string): RelayDescriptor;
export declare function verifyDescriptor(descriptor: RelayDescriptor, trusted: TrustedRelayEntry, nowMs?: number, clockSkewSec?: number): boolean;
export declare function loadTrustPolicy(pathname: string): TrustPolicy;
export declare function resolveDestinationRelayId(recipient: string, domains: Record<string, string> | undefined): string;
