import * as http from "http";

type AuthStatus = "disabled" | "ok" | "missing" | "invalid";

type EnvelopeLog = {
  id?: string;
  intent?: string;
  sender?: string;
  recipient?: string;
};

type ValidationError = { path: string; message: string };

type RelayErrorLike = Error & { code?: string; details?: unknown };

type Allowlist = {
  enabled: boolean;
  set: Set<string>;
};

type WebhookRelayType = {
  emitResponses: boolean;
  registerAgent: (
    agentId: string,
    handler: (envelope: unknown, context: any) => void | Promise<void>
  ) => void;
  receive: (envelope: unknown) => Promise<unknown[]>;
};

const { WebhookRelay, RelayError } = require("../../runtime/relay") as {
  WebhookRelay: new (options?: { emitResponses?: boolean }) => WebhookRelayType;
  RelayError: new (code: string, message: string, details?: unknown) => RelayErrorLike;
};

const { validateEnvelope } = require("../../runtime/validation") as {
  validateEnvelope: (envelope: unknown) => ValidationError[];
};

const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js") as {
  createEnvelope: (payload: any) => any;
  createMessage: (payload: any) => any;
  createTaskResponse: (payload: any) => any;
};

const packageJson = require("../../package.json") as { version?: string };

const DEFAULT_PORT = 8787;
const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed;
}

function parseAllowlist(value: string | undefined): Allowlist {
  if (!value) {
    return { enabled: false, set: new Set<string>() };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { enabled: entries.length > 0, set: new Set(entries) };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown
): void {
  const payload: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    payload.details = details;
  }
  sendJson(res, status, payload);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractAuthKey(req: http.IncomingMessage): string {
  const direct = firstHeaderValue(req.headers["x-aimtp-key"] as string | string[] | undefined);
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const authorization = firstHeaderValue(req.headers.authorization);
  if (typeof authorization !== "string") {
    return "";
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return "";
  }
  const token = match[1].trim();
  return token ? token : "";
}

function evaluateAuth(req: http.IncomingMessage, apiKey: string): {
  enabled: boolean;
  ok: boolean;
  status: AuthStatus;
} {
  if (!apiKey) {
    return { enabled: false, ok: true, status: "disabled" };
  }
  const provided = extractAuthKey(req);
  if (!provided) {
    return { enabled: true, ok: false, status: "missing" };
  }
  if (provided !== apiKey) {
    return { enabled: true, ok: false, status: "invalid" };
  }
  return { enabled: true, ok: true, status: "ok" };
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let finished = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    const drainRequest = () => {
      req.on("error", () => {});
      req.resume();
    };

    const onData = (chunk: Buffer) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        cleanup();
        const error = new Error("Request body exceeds maximum size") as RelayErrorLike;
        error.code = "payload_too_large";
        reject(error);
        drainRequest();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };

    const onError = (err: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function isRelayError(err: unknown): err is RelayErrorLike {
  if (!err || typeof err !== "object") {
    return false;
  }
  return err instanceof RelayError || Object.prototype.hasOwnProperty.call(err, "code");
}

const relay = new WebhookRelay({ emitResponses: true });

relay.registerAgent("aimtp-relay", async (_envelope, context) => {
  if (!context.task || context.task.kind !== "request") {
    return;
  }

  const responseEnvelope = createEnvelope({
    sender: "aimtp-relay",
    recipient: context.sender,
    intent: "task.response",
    message: createMessage({
      role: "assistant",
      content: `Task ${context.task.id} succeeded.`
    }),
    task: createTaskResponse({
      id: `${context.task.id}-resp-001`,
      in_response_to: context.task.id,
      status: "succeeded",
      output: { ok: true }
    })
  });

  context.emit(responseEnvelope);
});

const port = parseEnvInt(process.env.PORT, DEFAULT_PORT);
const relayPath = envPath("AIMTP_RELAY_PATH", DEFAULT_PATH) || DEFAULT_PATH;
const healthPath = envPath("AIMTP_HEALTH_PATH", DEFAULT_HEALTH_PATH) || DEFAULT_HEALTH_PATH;
const readyPath = envPath("AIMTP_READY_PATH", DEFAULT_READY_PATH);
const readyEnabled = readyPath !== "";
const maxBytes = parseEnvInt(process.env.AIMTP_MAX_BODY_BYTES, DEFAULT_MAX_BYTES);
const apiKey = process.env.AIMTP_API_KEY ? process.env.AIMTP_API_KEY.trim() : "";
const recipientAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_RECIPIENTS);
const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);

if (recipientAllowlist.enabled) {
  console.log(
    JSON.stringify({
      event: "allowlist_recipients",
      count: recipientAllowlist.set.size
    })
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";

  if (url.pathname === healthPath) {
    if (method !== "GET") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    sendJson(res, 200, {
      status: "ok",
      service: "aimtp-relay",
      version: packageJson.version,
      uptime_sec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (readyEnabled && url.pathname === readyPath) {
    if (method !== "GET") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    if (server.listening) {
      sendJson(res, 200, { status: "ready" });
    } else {
      sendJson(res, 503, { status: "not_ready" });
    }
    return;
  }

  const authResult = evaluateAuth(req, apiKey);
  const authStatus = authResult.status;
  let logEnvelope: EnvelopeLog | null = null;
  const logRequest = (status: number) => {
    const envelope = logEnvelope || {};
    const record = {
      id: envelope.id || "-",
      intent: envelope.intent || "-",
      sender: envelope.sender || "-",
      recipient: envelope.recipient || "-",
      status,
      auth: authStatus
    };
    console.log(JSON.stringify(record));
  };

  if (url.pathname !== relayPath) {
    sendError(res, 404, "not_found", "Not Found");
    logRequest(404);
    return;
  }

  if (authResult.enabled && !authResult.ok) {
    if (authStatus === "missing") {
      sendError(res, 401, "unauthorized", "Missing API key");
      logRequest(401);
      return;
    }
    sendError(res, 403, "forbidden", "Invalid API key");
    logRequest(403);
    return;
  }

  if (method !== "POST") {
    sendError(res, 405, "method_not_allowed", "Method not allowed");
    logRequest(405);
    return;
  }

  let payload: unknown;
  try {
    const raw = await readRequestBody(req, maxBytes);
    payload = JSON.parse(raw);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      logEnvelope = payload as EnvelopeLog;
    }
  } catch (err) {
    if (isRelayError(err) && err.code === "payload_too_large") {
      sendError(res, 413, "payload_too_large", "Request body exceeds maximum size");
      logRequest(413);
      return;
    }
    sendError(res, 400, "invalid_json", "Invalid JSON payload");
    logRequest(400);
    return;
  }

  const validationErrors = validateEnvelope(payload);
  if (validationErrors.length > 0) {
    sendError(res, 400, "invalid_schema", "Schema validation failed", validationErrors);
    logRequest(400);
    return;
  }

  if (recipientAllowlist.enabled) {
    const recipient =
      payload && typeof (payload as { recipient?: unknown }).recipient === "string"
        ? (payload as { recipient: string }).recipient.trim()
        : "";
    if (!recipient) {
      sendError(res, 400, "invalid_request", "Recipient is required", { recipient: null });
      logRequest(400);
      return;
    }
    if (!recipientAllowlist.set.has(recipient)) {
      sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
        recipient
      });
      logRequest(404);
      return;
    }
    sendJson(res, 202, { status: "accepted", id: (payload as { id?: string }).id, recipient });
    logRequest(202);
    return;
  }

  if (senderAllowlist.enabled) {
    const sender =
      payload && typeof (payload as { sender?: unknown }).sender === "string"
        ? (payload as { sender: string }).sender.trim()
        : "";
    if (!sender) {
      sendError(res, 403, "unknown_sender", "Sender is required", { sender: null });
      logRequest(403);
      return;
    }
    if (!senderAllowlist.set.has(sender)) {
      sendError(res, 403, "unknown_sender", `Unknown sender: ${sender}`, { sender });
      logRequest(403);
      return;
    }
  }

  try {
    const responses = await relay.receive(payload);
    if (relay.emitResponses) {
      sendJson(res, 200, responses);
      logRequest(200);
    } else {
      res.statusCode = 204;
      res.end();
      logRequest(204);
    }
  } catch (err) {
    if (isRelayError(err)) {
      const code = err.code || "internal_error";
      if (code === "invalid_envelope" || code === "invalid_response") {
        const details =
          (err.details &&
            typeof err.details === "object" &&
            Array.isArray((err.details as { errors?: unknown }).errors)
            ? (err.details as { errors: unknown[] }).errors
            : Array.isArray(err.details)
              ? err.details
              : undefined);
        sendError(res, 400, "invalid_schema", "Schema validation failed", details);
        logRequest(400);
        return;
      }
      if (code === "missing_recipient") {
        sendError(res, 400, code, err.message || "Recipient is required");
        logRequest(400);
        return;
      }
      if (code === "unknown_recipient") {
        sendError(res, 404, code, err.message || "Unknown recipient");
        logRequest(404);
        return;
      }
      if (code === "handler_error") {
        sendError(res, 500, code, err.message || "Handler raised an error");
        logRequest(500);
        return;
      }
      sendError(res, 500, code, err.message || "Internal server error");
      logRequest(500);
      return;
    }

    sendError(res, 500, "internal_error", "Internal server error");
    logRequest(500);
  }
});

server.listen(port, () => {
  console.log(`AIMTP relay listening on port ${port}${relayPath}`);
});

let shutdownInProgress = false;
function shutdown(reason: string) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  console.log(JSON.stringify({ event: "shutdown", reason }));
  server.close(() => {
    process.exit(0);
  });
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});
