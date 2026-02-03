"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInMemoryTaskDemo = runInMemoryTaskDemo;
const registry_1 = require("./registry");
const router_1 = require("./router");
const PROTOCOL_VERSION = "aimtp/0.1";
const NOOP_LOGGER = { log: (_message) => { } };
function buildEnvelope(params) {
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
async function runInMemoryTaskDemo(logger = NOOP_LOGGER) {
    const registry = new registry_1.AgentRegistry();
    const router = new router_1.MessageRouter(registry);
    const agentA = { id: "agent-a", name: "Agent A" };
    const agentB = { id: "agent-b", name: "Agent B" };
    let responseEnvelope;
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
        const responseTask = {
            kind: "response",
            id: context.task.id,
            in_response_to: context.task.id,
            status: "succeeded",
            output: { result: "done" }
        };
        const responseMessage = {
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
    const requestTask = {
        kind: "request",
        id: "task-001",
        type: "demo",
        input: { payload: "ping" },
        expects_response: true
    };
    const requestMessage = {
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
