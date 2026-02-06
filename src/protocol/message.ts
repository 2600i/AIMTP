import { AIMTPTask } from "./task";

export type Role = "system" | "user" | "assistant" | "tool";

export interface AIMTPAttachment {
  name: string;
  content_type: string;
  size: number;
  sha256?: string;
  url?: string;
}

export type AIMTPIntentType = string;

export type AIMTPIntentPriority = "low" | "normal" | "high" | "urgent" | number;

export interface AIMTPIntentHint {
  type: AIMTPIntentType;
  priority?: AIMTPIntentPriority;
  deadline?: string;
  requires_ack?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

export interface AIMTPAction {
  id: string;
  type: string;
  inputs: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  on_success?: Record<string, unknown>;
  on_failure?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AIMTPCapabilities {
  offered?: string[];
  required?: string[];
  [key: string]: unknown;
}

export interface AIMTPNegotiation {
  offer?: Record<string, unknown>;
  counter?: Record<string, unknown>;
  accept?: boolean;
  reject?: boolean;
  [key: string]: unknown;
}

export type AIMTPIntent = string | AIMTPIntentHint;

export interface AIMTPMessage {
  id: string;
  role: Role;
  content: AIMTPContent;
  content_type?: string;
  intent?: AIMTPIntent;
  actions?: AIMTPAction[];
  capabilities?: AIMTPCapabilities;
  negotiation?: AIMTPNegotiation;
  attachments?: AIMTPAttachment[];
  metadata?: Record<string, unknown>;
}

export type AIMTPContent =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | Array<unknown>;

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
  intent?: AIMTPIntent;
  actions?: AIMTPAction[];
  capabilities?: AIMTPCapabilities;
  negotiation?: AIMTPNegotiation;
  message: TMessage;
  task?: AIMTPTask;
  signature?: AIMTPSignature;
  metadata?: Record<string, unknown>;
}

export type Attachment = AIMTPAttachment;
export type Message = AIMTPMessage;
