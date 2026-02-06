import { AIMTPTask } from "./task";
export type Role = "system" | "user" | "assistant" | "tool";
export interface AIMTPAttachment {
    name: string;
    content_type: string;
    size: number;
    sha256?: string;
    url?: string;
}
export interface AIMTPMessage {
    id: string;
    role: Role;
    content: AIMTPContent;
    content_type?: string;
    attachments?: AIMTPAttachment[];
    metadata?: Record<string, unknown>;
}
export type AIMTPContent = string | number | boolean | null | Record<string, unknown> | Array<unknown>;
export interface AIMTPSignature {
    alg?: string;
    kid?: string;
    sig?: string;
    key_id?: string;
    signature?: string;
    created_at?: string;
    expires_at?: string;
}
export interface AIMTPEnvelope<TMessage = AIMTPMessage> {
    spec: "aimtp/0.1";
    id: string;
    timestamp: string;
    sender?: string;
    recipient?: string;
    intent?: string;
    message: TMessage;
    task?: AIMTPTask;
    signature?: AIMTPSignature;
    metadata?: Record<string, unknown>;
}
export type Attachment = AIMTPAttachment;
export type Message = AIMTPMessage;
