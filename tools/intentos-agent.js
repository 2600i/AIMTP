#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { createEnvelope, createMessage, createTaskResponse } = require("../sdk/js");

function parseIntOrDefault(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(baseUrl, method, routePath, payload, apiKey) {
  const url = new URL(routePath, baseUrl);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;
  const headers = {
    Accept: "application/json"
  };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  if (apiKey) {
    headers["X-AIMTP-KEY"] = apiKey;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (_err) {
              parsed = { raw };
            }
          }
          resolve({
            status: typeof res.statusCode === "number" ? res.statusCode : 500,
            body: parsed
          });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function classifyGoal(goal) {
  const normalized = (goal || "").toLowerCase();
  if (normalized.includes("bug") || normalized.includes("error") || normalized.includes("incident")) {
    return "support";
  }
  if (normalized.includes("summary") || normalized.includes("summarize") || normalized.includes("report")) {
    return "analysis";
  }
  return "general";
}

function executeStubTask(taskType, input) {
  const goal = input && typeof input.goal === "string" ? input.goal : "";
  if (taskType === "classify") {
    return {
      status: "completed",
      output: {
        category: classifyGoal(goal)
      }
    };
  }
  if (taskType === "draft_reply") {
    return {
      status: "completed",
      output: {
        template: `Thanks for the request. We are processing: ${goal || "(no goal provided)"}.`
      }
    };
  }
  return {
    status: "failed",
    error: `unsupported_task_type:${taskType || "unknown"}`
  };
}

function extractTaskContext(envelope) {
  const metadata = envelope && envelope.metadata && typeof envelope.metadata === "object" ? envelope.metadata : {};
  const intentos = metadata.intentos && typeof metadata.intentos === "object" ? metadata.intentos : {};
  const task = envelope && envelope.task && typeof envelope.task === "object" ? envelope.task : {};

  const taskId =
    (typeof intentos.task_id === "string" && intentos.task_id.trim()) ||
    (typeof task.id === "string" && task.id.trim()) ||
    "";
  const intentId = typeof intentos.intent_id === "string" ? intentos.intent_id.trim() : "";
  const taskType =
    (typeof intentos.task_type === "string" && intentos.task_type.trim()) ||
    (typeof task.type === "string" && task.type.trim()) ||
    "";
  const taskInput = task.input && typeof task.input === "object" ? task.input : {};

  return {
    taskId,
    intentId,
    taskType,
    taskInput
  };
}

function buildResultEnvelope(agentId, orchestratorRecipient, sourceEnvelope, taskContext, execution) {
  return createEnvelope({
    sender: agentId,
    recipient: orchestratorRecipient,
    intent: execution.status === "failed" ? "task.fail" : "task.result",
    message: createMessage({
      role: "assistant",
      content:
        execution.status === "failed"
          ? `Task ${taskContext.taskId} failed`
          : `Task ${taskContext.taskId} completed`
    }),
    task: createTaskResponse({
      in_response_to: taskContext.taskId,
      status: execution.status,
      type: taskContext.taskType,
      output: execution.output,
      error: execution.error
    }),
    metadata: {
      intentos: {
        intent_id: taskContext.intentId,
        task_id: taskContext.taskId,
        source_envelope_id:
          sourceEnvelope && typeof sourceEnvelope.id === "string" ? sourceEnvelope.id : ""
      }
    }
  });
}

async function processLease(config, item) {
  const envelope = item && item.envelope && typeof item.envelope === "object" ? item.envelope : null;
  const leaseId = item && typeof item.lease_id === "string" ? item.lease_id : "";
  if (!envelope || !leaseId) {
    return;
  }

  const taskContext = extractTaskContext(envelope);
  if (!taskContext.taskId) {
    await requestJson(
      config.baseUrl,
      "POST",
      `${config.relayPath}/ack`,
      { recipient: config.agentId, lease_id: leaseId },
      config.apiKey
    );
    return;
  }

  const claim = await requestJson(
    config.baseUrl,
    "POST",
    `/intentos/task/${encodeURIComponent(taskContext.taskId)}/claim`,
    { agent_id: config.agentId },
    config.apiKey
  );

  if (claim.status !== 200) {
    await requestJson(
      config.baseUrl,
      "POST",
      `${config.relayPath}/ack`,
      { recipient: config.agentId, lease_id: leaseId },
      config.apiKey
    );
    console.log(
      JSON.stringify({
        event: "intentos_agent_claim_skipped",
        agent_id: config.agentId,
        task_id: taskContext.taskId,
        reason_status: claim.status
      })
    );
    return;
  }

  const execution = executeStubTask(taskContext.taskType, taskContext.taskInput);

  const resultResponse = await requestJson(
    config.baseUrl,
    "POST",
    `/intentos/task/${encodeURIComponent(taskContext.taskId)}/result`,
    {
      agent_id: config.agentId,
      status: execution.status,
      output: execution.output,
      error: execution.error
    },
    config.apiKey
  );

  const resultEnvelope = buildResultEnvelope(
    config.agentId,
    config.orchestratorRecipient,
    envelope,
    taskContext,
    execution
  );
  const relayResult = await requestJson(
    config.baseUrl,
    "POST",
    config.relayPath,
    resultEnvelope,
    config.apiKey
  );

  await requestJson(
    config.baseUrl,
    "POST",
    `${config.relayPath}/ack`,
    { recipient: config.agentId, lease_id: leaseId },
    config.apiKey
  );

  console.log(
    JSON.stringify({
      event: "intentos_agent_task_processed",
      agent_id: config.agentId,
      task_id: taskContext.taskId,
      status: execution.status,
      result_status: resultResponse.status,
      relay_status: relayResult.status
    })
  );
}

async function processCycle(config) {
  const poll = await requestJson(
    config.baseUrl,
    "GET",
    `${config.relayPath}/poll?recipient=${encodeURIComponent(config.agentId)}&max=5`,
    undefined,
    config.apiKey
  );
  if (poll.status !== 200 || !Array.isArray(poll.body) || poll.body.length === 0) {
    return;
  }

  for (const item of poll.body) {
    await processLease(config, item);
  }
}

async function main() {
  const config = {
    baseUrl: process.env.INTENTOS_BASE_URL || "http://127.0.0.1:8080",
    relayPath: process.env.AIMTP_RELAY_PATH || "/aimtp",
    apiKey: process.env.AIMTP_API_KEY || "",
    agentId: process.env.INTENTOS_AGENT_ID || "agent.intentos.default",
    orchestratorRecipient:
      process.env.INTENTOS_ORCHESTRATOR_RECIPIENT || "service.intentos.orchestrator",
    intervalMs: parseIntOrDefault(process.env.INTENTOS_AGENT_POLL_INTERVAL_MS, 1000),
    once: process.argv.includes("--once") || process.env.INTENTOS_ONCE === "1"
  };

  do {
    try {
      await processCycle(config);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "intentos_agent_error",
          agent_id: config.agentId,
          reason: err && err.message ? err.message : String(err)
        })
      );
    }

    if (config.once) {
      break;
    }
    await sleep(config.intervalMs);
  } while (true);
}

main();
