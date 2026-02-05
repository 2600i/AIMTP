import { AIMTPEnvelope } from "../protocol/message";
export interface TaskExchangeResult {
    requestEnvelope: AIMTPEnvelope;
    responseEnvelope: AIMTPEnvelope;
}
export declare function runInMemoryTaskDemo(logger?: {
    log: (message: string) => void;
}): Promise<TaskExchangeResult>;
export declare function runMailboxHttpDemo(params: {
    baseUrl: string;
    apiKey: string;
    sender: string;
    recipient: string;
    content: string;
}): Promise<{
    peekCount: number;
    polled: unknown[];
}>;
