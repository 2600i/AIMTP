export interface AIMTPAgent {
  id: string;
  name?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export type Agent = AIMTPAgent;
