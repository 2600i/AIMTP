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

export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  register(agent: Agent, handler: AgentHandler): void {
    if (!agent.id || agent.id.trim() === "") {
      throw new Error("Agent id is required");
    }
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, { agent, handler });
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): Agent[] {
    return Array.from(this.agents.values(), ({ agent }) => agent);
  }
}
