export interface AIMTPCapabilityScope {
    action: string;
    resource: string;
}
export interface AIMTPCapabilityDocument {
    issuer: string;
    subject: string;
    aud: string;
    iat: number;
    exp: number;
    scopes: AIMTPCapabilityScope[];
}
export interface AIMTPCapabilitySignature {
    alg: "ed25519" | "secp256k1";
    kid: string;
    sig: string;
}
export interface AIMTPCapabilityPresentation {
    chain: AIMTPCapabilityDocument[];
    signature: AIMTPCapabilitySignature;
    public_key?: string;
}
export type CapabilityScope = AIMTPCapabilityScope;
export type CapabilityDocument = AIMTPCapabilityDocument;
export type CapabilitySignature = AIMTPCapabilitySignature;
export type CapabilityPresentation = AIMTPCapabilityPresentation;
