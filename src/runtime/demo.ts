import { AIMTPAgent } from "../protocol/agent";
import { AIMTPEnvelope, AIMTPMessage } from "../protocol/message";
import { AIMTPTaskRequest, AIMTPTaskResponse } from "../protocol/task";
import { AgentRegistry } from "./registry";
import { MessageRouter } from "./router";

export interface TaskExchangeResult {
  requestEnvelope: AIMTPEnvelope;
  responseEnvelope: AIMTPEnvelope;
}

const PROTOCOL_VERSION = "aimtp/0.1";
const NOOP_LOGGER = { log: (_message: string) => {} };

function buildEnvelope(params: {
  sender?: string;
  recipients?: string[];
  thread_id?: string;
  intent: string;
  message: AIMTPMessage;
  task?: AIMTPTaskRequest | AIMTPTaskResponse;
}): AIMTPEnvelope {
  return {
    version: PROTOCOL_VERSION,
    id: `env-${params.message.id}`,
    timestamp: new Date().toISOString(),
    sender: params.sender,
    recipients: params.recipients,
    thread_id: params.thread_id,
    intent: params.intent,
    payload: params.message,
    metadata: params.task ? { task: params.task } : undefined
  };
}

export async function runInMemoryTaskDemo(
  logger: { log: (message: string) => void } = NOOP_LOGGER
): Promise<TaskExchangeResult> {
  const registry = new AgentRegistry();
  const router = new MessageRouter(registry);

  const agentA: AIMTPAgent = { id: "agent-a", name: "Agent A" };
  const agentB: AIMTPAgent = { id: "agent-b", name: "Agent B" };

  let responseEnvelope: AIMTPEnvelope | undefined;

  registry.register(agentA, (message, context) => {
    if (!context?.task || context.task.kind !== "response") {
      return;
    }
    logger.log(`Agent A received task response ${context.task.id}`);
    responseEnvelope = buildEnvelope({
      sender: context.sender,
      recipients: [agentA.id],
      thread_id: `task-${context.task.in_response_to}`,
      intent: "task.response",
      message,
      task: context.task
    });
  });

  registry.register(agentB, async (_message, context) => {
    if (!context?.task || context.task.kind !== "request") {
      return;
    }
    logger.log(`Agent B received task request ${context.task.id}`);

    const responseTask: AIMTPTaskResponse = {
      kind: "response",
      id: context.task.id,
      in_response_to: context.task.id,
      status: "succeeded",
      output: { result: "done" }
    };

    const responseMessage: AIMTPMessage = {
      id: `msg-${context.task.id}-response`,
      role: "assistant",
      content: "Task completed."
    };

    logger.log(`Agent B responds to ${context.task.id}`);
    await router.deliver({
      sender: agentB.id,
      recipients: [context.sender ?? agentA.id],
      message: responseMessage,
      task: responseTask
    });
  });

  logger.log("Agent A registers");
  logger.log("Agent B registers");

  const requestTask: AIMTPTaskRequest = {
    kind: "request",
    id: "task-001",
    type: "demo",
    input: { payload: "ping" },
    expects_response: true
  };

  const requestMessage: AIMTPMessage = {
    id: "msg-task-001",
    role: "user",
    content: "Please run the demo task."
  };

  const requestEnvelope = buildEnvelope({
    sender: agentA.id,
    recipients: [agentB.id],
    thread_id: requestTask.id,
    intent: "task.request",
    message: requestMessage,
    task: requestTask
  });

  logger.log(`Agent A sends task ${requestTask.id} to Agent B`);
  await router.deliver({
    sender: agentA.id,
    recipients: [agentB.id],
    message: requestMessage,
    task: requestTask
  });

  if (!responseEnvelope) {
    throw new Error("No response received from agent-b");
  }

  logger.log("Task exchange complete");
  return { requestEnvelope, responseEnvelope };
}
