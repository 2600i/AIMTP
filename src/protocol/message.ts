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
  content: string;
  content_type?: string;
  attachments?: AIMTPAttachment[];
  metadata?: Record<string, unknown>;
}

export interface AIMTPSecurity {
  key_id?: string;
  signature?: string;
  alg?: string;
  metadata?: Record<string, unknown>;
}

export interface AIMTPEnvelope<TPayload = AIMTPMessage> {
  version: string;
  id: string;
  thread_id?: string;
  timestamp: string;
  sender?: string;
  recipients?: string[];
  intent?: string;
  payload: TPayload;
  ai_policy?: Record<string, unknown>;
  security?: AIMTPSecurity;
  metadata?: Record<string, unknown>;
}

export type Attachment = AIMTPAttachment;
export type Message = AIMTPMessage;
