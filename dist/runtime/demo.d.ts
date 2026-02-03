import { AIMTPEnvelope } from "../protocol/message";
export interface TaskExchangeResult {
    requestEnvelope: AIMTPEnvelope;
    responseEnvelope: AIMTPEnvelope;
}
export declare function runInMemoryTaskDemo(logger?: {
    log: (message: string) => void;
}): Promise<TaskExchangeResult>;
