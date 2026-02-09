#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");

function parseArgs(argv) {
  const result = {
    goal: "",
    box: "default",
    meta: {}
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--goal") {
      result.goal = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--box") {
      result.box = argv[i + 1] || "default";
      i += 1;
      continue;
    }
    if (arg === "--meta") {
      const raw = argv[i + 1] || "{}";
      i += 1;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("meta_object_required");
        }
        result.meta = parsed;
      } catch (_err) {
        throw new Error("invalid_meta_json");
      }
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

function requestJson(baseUrl, method, routePath, payload, apiKey) {
  const endpoint = new URL(routePath, baseUrl);
  const body = JSON.stringify(payload);
  const transport = endpoint.protocol === "https:" ? https : http;
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Accept: "application/json"
  };
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
    req.write(body);
    req.end();
  });
}

function printUsage() {
  console.log(
    "Usage: node tools/intentos-submit.js --goal \"...\" [--box default] [--meta '{\"k\":\"v\"}']"
  );
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
  if (!args.goal || !args.goal.trim()) {
    printUsage();
    console.error("goal_required");
    process.exit(1);
  }

  const relayUrl = process.env.AIMTP_RELAY_URL || "http://127.0.0.1:8787";
  const apiKey = process.env.AIMTP_API_KEY || "";

  try {
    const response = await requestJson(relayUrl, "POST", "/intentos/intent", {
      goal: args.goal.trim(),
      box_id: args.box || "default",
      metadata: args.meta
    }, apiKey);

    if (response.status < 200 || response.status >= 300 || !response.body || !response.body.intent_id) {
      console.error("submit_failed", JSON.stringify(response.body || {}));
      process.exit(1);
    }

    const intentId = response.body.intent_id;
    console.log(intentId);
    console.log(`submitted intent ${intentId}`);
  } catch (err) {
    console.error("submit_error", err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

main();
