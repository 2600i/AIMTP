export type AIMTPTaskStatus = "pending" | "running" | "succeeded" | "failed";
export interface AIMTPTaskError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}
export interface AIMTPTaskBase {
    id: string;
    type?: string;
    metadata?: Record<string, unknown>;
}
export interface AIMTPTaskRequest extends AIMTPTaskBase {
    kind: "request";
    input?: Record<string, unknown>;
    expects_response?: boolean;
}
export interface AIMTPTaskResponse extends AIMTPTaskBase {
    kind: "response";
    in_response_to: string;
    status: AIMTPTaskStatus;
    output?: Record<string, unknown>;
    error?: AIMTPTaskError;
}
export type AIMTPTask = AIMTPTaskRequest | AIMTPTaskResponse;
export type AIMTPResponse = AIMTPTaskResponse;
export type TaskStatus = AIMTPTaskStatus;
export type TaskError = AIMTPTaskError;
export type Task = AIMTPTask;
export type TaskRequest = AIMTPTaskRequest;
export type TaskResponse = AIMTPTaskResponse;
export type Response = AIMTPResponse;
