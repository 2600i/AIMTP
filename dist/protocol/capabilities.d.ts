export interface CapabilityScope {
    action: string;
    resource: string;
}
export interface CapabilityConstraints {
    max_hops?: number;
    rate_limit?: {
        per_minute?: number;
    };
    audience?: string[];
    [key: string]: unknown;
}
export interface CapabilityDelegation {
    allowed: boolean;
    max_depth?: number;
}
export interface CapabilityDocument {
    id: string;
    type: "aimtp.capability";
    issuer: string;
    subject: string;
    scopes: CapabilityScope[];
    constraints?: CapabilityConstraints;
    delegation?: CapabilityDelegation;
    issued_at?: string;
    expires_at?: string;
    proof: {
        type?: string;
        alg: "ed25519";
        kid: string;
        sig: string;
        created_at?: string;
        expires_at?: string;
    };
    [key: string]: unknown;
}
export interface AuthorizationRequest {
    action: string;
    resource: string;
    subject?: string;
    audience?: string;
    hops?: number;
}
export interface CapabilityChain {
    chain: CapabilityDocument[];
    purpose?: string;
    requested?: AuthorizationRequest;
}
export interface AuthorizationDecision {
    allow: boolean;
    reason_code: string;
    message: string;
    details?: Record<string, unknown>;
}
