import { Agent } from "../protocol/agent";
import { Message } from "../protocol/message";
import { Task } from "../protocol/task";
export interface RouteContext {
    sender?: string;
    task?: Task;
    metadata?: Record<string, unknown>;
}
export type AgentHandler = (message: Message, context?: RouteContext) => void | Promise<void>;
export interface RegisteredAgent {
    agent: Agent;
    handler: AgentHandler;
}
export declare class AgentRegistry {
    private readonly agents;
    register(agent: Agent, handler: AgentHandler): void;
    unregister(agentId: string): void;
    get(agentId: string): RegisteredAgent | undefined;
    list(): Agent[];
}
