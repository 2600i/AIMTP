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

export class RouteError extends Error {
  readonly missingRecipients: string[];

  constructor(missingRecipients: string[]) {
    super(`Unknown recipient(s): ${missingRecipients.join(", ")}`);
    this.missingRecipients = missingRecipients;
  }
}

export class MessageRouter {
  constructor(private readonly registry: AgentRegistry) {}

  async deliver(route: Route): Promise<void> {
    if (!route.recipients || route.recipients.length === 0) {
      throw new Error("At least one recipient is required");
    }

    const missing: string[] = [];
    for (const recipient of route.recipients) {
      if (!this.registry.get(recipient)) {
        missing.push(recipient);
      }
    }

    if (missing.length > 0) {
      throw new RouteError(missing);
    }

    for (const recipient of route.recipients) {
      const target = this.registry.get(recipient);
      if (!target) {
        continue;
      }
      await target.handler(route.message, {
        sender: route.sender,
        task: route.task,
        metadata: route.metadata
      });
    }
  }
}
