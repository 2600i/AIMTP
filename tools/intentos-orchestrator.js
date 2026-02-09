#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { createEnvelope, createMessage, createTaskRequest } = require("../sdk/js");

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
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
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

function deterministicPlan(intent) {
  const goal = intent && typeof intent.goal === "string" ? intent.goal : "";
  return [
    {
      type: "classify",
      input: {
        goal
      }
    },
    {
      type: "draft_reply",
      input: {
        goal
      }
    }
  ];
}

function buildTaskEnvelope(orchestratorId, recipient, intent, task) {
  return createEnvelope({
    sender: orchestratorId,
    recipient,
    intent: "task.create",
    message: createMessage({
      role: "system",
      content: `Execute ${task.type} for intent ${intent.id}`
    }),
    task: createTaskRequest({
      id: task.id,
      type: task.type,
      input: task.input,
      expects_response: true,
      metadata: {
        intent_id: intent.id
      }
    }),
    metadata: {
      intentos: {
        intent_id: intent.id,
        task_id: task.id,
        task_type: task.type
      }
    }
  });
}

async function processCycle(config, seenFinal) {
  const submitted = await requestJson(
    config.baseUrl,
    "GET",
    "/intentos/intents?status=submitted&limit=20",
    undefined,
    config.apiKey
  );
  if (submitted.status !== 200 || !submitted.body || !Array.isArray(submitted.body.intents)) {
    return;
  }

  for (const intent of submitted.body.intents) {
    const detail = await requestJson(
      config.baseUrl,
      "GET",
      `/intentos/intent/${encodeURIComponent(intent.id)}`,
      undefined,
      config.apiKey
    );
    if (detail.status !== 200 || !detail.body || !Array.isArray(detail.body.tasks)) {
      continue;
    }

    if (detail.body.tasks.length > 0) {
      continue;
    }

    const plan = deterministicPlan(detail.body.intent || intent);
    for (const step of plan) {
      const createTaskResponse = await requestJson(
        config.baseUrl,
        "POST",
        "/intentos/task",
        {
          intent_id: intent.id,
          type: step.type,
          input: step.input
        },
        config.apiKey
      );

      if (createTaskResponse.status !== 202 || !createTaskResponse.body || !createTaskResponse.body.task_id) {
        continue;
      }

      const task = {
        id: createTaskResponse.body.task_id,
        type: step.type,
        input: step.input
      };

      const envelope = buildTaskEnvelope(config.orchestratorId, config.agentRecipient, intent, task);
      const relaySend = await requestJson(
        config.baseUrl,
        "POST",
        config.relayPath,
        envelope,
        config.apiKey
      );

      const relayAccepted = relaySend.status >= 200 && relaySend.status < 300;
      console.log(
        JSON.stringify({
          event: "intentos_orchestrator_task_created",
          intent_id: intent.id,
          task_id: task.id,
          task_type: task.type,
          relay_outcome: relayAccepted ? "accepted" : "rejected",
          relay_status: relaySend.status
        })
      );
    }
  }

  const allIntents = await requestJson(
    config.baseUrl,
    "GET",
    "/intentos/intents?limit=50",
    undefined,
    config.apiKey
  );
  if (allIntents.status !== 200 || !allIntents.body || !Array.isArray(allIntents.body.intents)) {
    return;
  }

  for (const intent of allIntents.body.intents) {
    if (intent.status !== "completed" && intent.status !== "failed") {
      continue;
    }
    if (seenFinal.has(intent.id)) {
      continue;
    }
    seenFinal.add(intent.id);
    console.log(
      JSON.stringify({
        event: "intentos_orchestrator_intent_final",
        intent_id: intent.id,
        status: intent.status
      })
    );
  }
}

async function main() {
  const config = {
    baseUrl: process.env.INTENTOS_BASE_URL || "http://127.0.0.1:8080",
    relayPath: process.env.AIMTP_RELAY_PATH || "/aimtp",
    apiKey: process.env.AIMTP_API_KEY || "",
    orchestratorId: process.env.INTENTOS_ORCHESTRATOR_ID || "service.intentos.orchestrator",
    agentRecipient: process.env.INTENTOS_AGENT_RECIPIENT || "agent.intentos.default",
    intervalMs: parseIntOrDefault(process.env.INTENTOS_POLL_INTERVAL_MS, 1000),
    once: process.argv.includes("--once") || process.env.INTENTOS_ONCE === "1"
  };

  const seenFinal = new Set();

  do {
    try {
      await processCycle(config, seenFinal);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "intentos_orchestrator_error",
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
