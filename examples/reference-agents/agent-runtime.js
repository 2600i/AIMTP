"use strict";

const http = require("http");

function requestJson(baseUrl, method, path, payload, headers = {}) {
  const target = new URL(path, baseUrl);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const options = {
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname + target.search,
    method,
    headers: Object.assign(
      {},
      payload === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          },
      headers
    )
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) {
          resolve({ status: res.statusCode || 0, body: null, headers: res.headers });
          return;
        }
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw), headers: res.headers });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function normalizeRelayPath(relayPath) {
  if (typeof relayPath !== "string" || relayPath.trim() === "") {
    return "/aimtp";
  }
  const path = relayPath.trim();
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

class MailboxClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "http://127.0.0.1:8787";
    this.relayPath = normalizeRelayPath(options.relayPath || "/aimtp");
    this.apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  }

  authHeaders() {
    if (!this.apiKey) {
      return {};
    }
    return { "X-AIMTP-KEY": this.apiKey };
  }

  async enqueueEnvelope(envelope) {
    return requestJson(this.baseUrl, "POST", this.relayPath, envelope, this.authHeaders());
  }

  async poll(recipient, max = 1) {
    const query = new URLSearchParams({ recipient, max: String(max) }).toString();
    return requestJson(
      this.baseUrl,
      "GET",
      `${this.relayPath}/poll?${query}`,
      undefined,
      this.authHeaders()
    );
  }

  async ack(recipient, leaseId) {
    return requestJson(
      this.baseUrl,
      "POST",
      `${this.relayPath}/ack`,
      { recipient, lease_id: leaseId },
      this.authHeaders()
    );
  }

  async fail(recipient, leaseId, reason) {
    return requestJson(
      this.baseUrl,
      "POST",
      `${this.relayPath}/fail`,
      { recipient, lease_id: leaseId, reason },
      this.authHeaders()
    );
  }

  async deadLetters(recipient, max = 10) {
    const query = new URLSearchParams({ recipient, max: String(max) }).toString();
    return requestJson(
      this.baseUrl,
      "GET",
      `${this.relayPath}/dead?${query}`,
      undefined,
      this.authHeaders()
    );
  }
}

async function processOneLease(params) {
  const pollResult = await params.client.poll(params.recipient, 1);
  if (pollResult.status !== 200 || !Array.isArray(pollResult.body) || pollResult.body.length === 0) {
    return { processed: false, poll: pollResult };
  }

  const lease = pollResult.body[0];
  const envelope = lease.envelope;
  const leaseId = lease.lease_id;
  if (!leaseId) {
    throw new Error("Missing lease_id in poll response");
  }

  try {
    const result = await params.handler(envelope, lease);
    const outbound = Array.isArray(result && result.outbound) ? result.outbound : [];
    for (const outEnvelope of outbound) {
      const sendResult = await params.client.enqueueEnvelope(outEnvelope);
      if (sendResult.status !== 202) {
        throw new Error(`enqueue_failed:${sendResult.status}`);
      }
    }

    const successMode =
      typeof params.onSuccess === "function"
        ? await params.onSuccess({ envelope, lease, result })
        : "ack";
    if (successMode === "fail") {
      const failResult = await params.client.fail(
        params.recipient,
        leaseId,
        "simulated_post_process_failure"
      );
      return { processed: true, status: "failed_after_processing", lease, result, fail: failResult };
    }

    const ackResult = await params.client.ack(params.recipient, leaseId);
    return { processed: true, status: "acknowledged", lease, result, ack: ackResult };
  } catch (err) {
    const failResult = await params.client.fail(
      params.recipient,
      leaseId,
      err && err.message ? err.message : "handler_error"
    );
    return { processed: true, status: "failed", lease, error: err, fail: failResult };
  }
}

module.exports = {
  MailboxClient,
  processOneLease
};
