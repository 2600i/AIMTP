import { Message } from "../protocol/message";
import { Task } from "../protocol/task";
import { AgentRegistry } from "./registry";
export interface Route {
    sender?: string;
    recipients: string[];
    message: Message;
    task?: Task;
    metadata?: Record<string, unknown>;
}
export declare class RouteError extends Error {
    readonly missingRecipients: string[];
    constructor(missingRecipients: string[]);
}
export declare class MessageRouter {
    private readonly registry;
    constructor(registry: AgentRegistry);
    deliver(route: Route): Promise<void>;
}
