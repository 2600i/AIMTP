import { AIMTPAgent } from "../protocol/agent";
import { AIMTPEnvelope, AIMTPMessage } from "../protocol/message";
import { AIMTPTaskRequest, AIMTPTaskResponse } from "../protocol/task";
import { AgentRegistry } from "./registry";
import { MessageRouter } from "./router";

export interface TaskExchangeResult {
  requestEnvelope: AIMTPEnvelope;
  responseEnvelope: AIMTPEnvelope;
}

const PROTOCOL_VERSION: AIMTPEnvelope["spec"] = "aimtp/0.1";
const NOOP_LOGGER = { log: (_message: string) => {} };

function buildEnvelope(params: {
  sender?: string;
  recipient?: string;
  thread_id?: string;
  intent: string;
  message: AIMTPMessage;
  task?: AIMTPTaskRequest | AIMTPTaskResponse;
}): AIMTPEnvelope {
  const metadata = params.thread_id
    ? {
        aimtp: {
          thread_id: params.thread_id
        }
      }
    : undefined;
  return {
    spec: PROTOCOL_VERSION,
    id: `env-${params.message.id}`,
    timestamp: new Date().toISOString(),
    sender: params.sender,
    recipient: params.recipient,
    intent: params.intent,
    message: params.message,
    task: params.task,
    metadata
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
      recipient: agentA.id,
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

    const responseTaskId = `${context.task.id}-resp-001`;
    const responseTask: AIMTPTaskResponse = {
      kind: "response",
      id: responseTaskId,
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
    recipient: agentB.id,
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

export async function runMailboxHttpDemo(params: {
  baseUrl: string;
  apiKey: string;
  sender: string;
  recipient: string;
  content: string;
}): Promise<{ peekCount: number; polled: unknown[] }> {
  const base = new URL(params.baseUrl);
  const mailboxUrl = new URL("/aimtp/mailbox", base);
  const peekUrl = new URL("/aimtp/peek", base);
  peekUrl.search = new URLSearchParams({ recipient: params.recipient }).toString();
  const pollUrl = new URL("/aimtp/poll", base);
  pollUrl.search = new URLSearchParams({ recipient: params.recipient, max: "10" }).toString();

  const mailboxPayload = {
    recipient: params.recipient,
    message: {
      id: `msg-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sender: params.sender,
      recipient: params.recipient,
      role: "user",
      content: params.content
    }
  };

  await fetch(mailboxUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AIMTP-KEY": params.apiKey
    },
    body: JSON.stringify(mailboxPayload)
  });

  const peekResponse = await fetch(peekUrl, {
    method: "GET",
    headers: { "X-AIMTP-KEY": params.apiKey }
  });
  const peekBody = (await peekResponse.json()) as { count?: number };

  const pollResponse = await fetch(pollUrl, {
    method: "GET",
    headers: { "X-AIMTP-KEY": params.apiKey }
  });
  const polled = (await pollResponse.json()) as unknown[];

  return { peekCount: peekBody.count ?? 0, polled };
}
