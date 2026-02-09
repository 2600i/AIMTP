#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");

function parseArgs(argv) {
  const result = {
    id: "",
    interval: 1000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--id") {
      result.id = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--interval") {
      const raw = argv[i + 1] || "1000";
      i += 1;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("invalid_interval");
      }
      result.interval = parsed;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    throw new Error(`unknown_argument:${arg}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(baseUrl, routePath, apiKey) {
  const endpoint = new URL(routePath, baseUrl);
  const transport = endpoint.protocol === "https:" ? https : http;
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["X-AIMTP-KEY"] = apiKey;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "GET",
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
    req.end();
  });
}

function formatEvent(event) {
  const createdAt = typeof event.created_at === "string" ? event.created_at : "-";
  const type = typeof event.type === "string" ? event.type : "event";
  const taskId =
    event && event.data && typeof event.data.task_id === "string" ? event.data.task_id : "";
  const status =
    event && event.data && typeof event.data.status === "string" ? event.data.status : "";
  const suffix = [taskId, status].filter(Boolean).join(" ");
  return `${createdAt} ${type}${suffix ? ` ${suffix}` : ""}`;
}

function printUsage() {
  console.log("Usage: node tools/intentos-watch.js --id <intent_id> [--interval 1000]");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    printUsage();
    console.error(err.message || String(err));
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.id || !args.id.trim()) {
    printUsage();
    console.error("intent_id_required");
    process.exit(1);
  }

  const relayUrl = process.env.AIMTP_RELAY_URL || "http://127.0.0.1:8787";
  const apiKey = process.env.AIMTP_API_KEY || "";
  const seenEventIds = new Set();

  while (true) {
    let response;
    try {
      response = await getJson(
        relayUrl,
        `/intentos/intent/${encodeURIComponent(args.id.trim())}`,
        apiKey
      );
    } catch (err) {
      console.error("watch_error", err && err.message ? err.message : String(err));
      process.exit(1);
    }

    if (response.status !== 200 || !response.body || !response.body.intent) {
      console.error("watch_failed", JSON.stringify(response.body || {}));
      process.exit(1);
    }

    const events = Array.isArray(response.body.events) ? response.body.events : [];
    for (const event of events) {
      const eventId = event && typeof event.id === "string" ? event.id : "";
      if (eventId && seenEventIds.has(eventId)) {
        continue;
      }
      if (eventId) {
        seenEventIds.add(eventId);
      }
      console.log(formatEvent(event));
    }

    const status =
      response.body && response.body.intent && typeof response.body.intent.status === "string"
        ? response.body.intent.status
        : "";
    if (status === "completed") {
      process.exit(0);
    }
    if (status === "failed") {
      process.exit(1);
    }

    await sleep(args.interval);
  }
}

main();
