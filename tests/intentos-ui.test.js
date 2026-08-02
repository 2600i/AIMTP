"use strict";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const { signCapabilityPresentation } = require("../runtime/capabilities");
const {
  deriveIntentosApiBase,
  canonicalizeJsonValue,
  validateCapabilityShape,
  loadCapabilityFromInput,
  buildIntentosRequestHeaders,
  setApiKey
} = require("../runtime/static/intentos/app.js");

const TEST_API_KEY = "intentos-ui-test-key";
const AUTH_HEADERS = { "X-AIMTP-KEY": TEST_API_KEY };

function startServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(0, "127.0.0.1");
  });
}

function getText(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method || "GET",
        headers: options.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8")
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function generateEd25519PemKeyPair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

function mintCapabilityPresentation(options) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signCapabilityPresentation(
    [
      {
        issuer: options.issuer,
        subject: options.subject,
        aud: options.aud,
        iat: nowSec - 1,
        exp: nowSec + options.ttlSec,
        scopes: options.scopes
      }
    ],
    {
      privateKey: options.privateKey,
      publicKey: options.publicKey,
      kid: options.issuer
    }
  );
}

async function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(values[key]);
    }
  });
  try {
    return await fn();
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

async function withServer(env, fn, serverOptions = {}) {
  return withEnv(env, async () => {
    const relay = new WebhookRelay({ emitResponses: true });
    const server = createWebhookRelayServer(
      relay,
      Object.assign(
        {
          mailboxStoreType: "memory"
        },
        serverOptions
      )
    );
    try {
      await startServer(server);
    } catch (err) {
      if (err && err.code === "EPERM") {
        console.log("SKIP: intentos ui test (listen not permitted)");
        return false;
      }
      throw err;
    }
    const port = server.address().port;
    try {
      await fn(port);
    } finally {
      server.close();
    }
    return true;
  });
}

async function main() {
  assert.strictEqual(deriveIntentosApiBase("/intentos/ui"), "/intentos");
  assert.strictEqual(deriveIntentosApiBase("/intentos/ui/"), "/intentos");
  assert.strictEqual(deriveIntentosApiBase("/intentos/ui/app.js"), "/intentos");
  assert.strictEqual(deriveIntentosApiBase("/aimtp/intentos/ui"), "/aimtp/intentos");
  assert.strictEqual(deriveIntentosApiBase("/aimtp/intentos/ui/"), "/aimtp/intentos");
  assert.strictEqual(deriveIntentosApiBase("/aimtp/intentos/ui/app.js"), "/aimtp/intentos");
  const sampleCapability = {
    chain: [
      {
        issuer: "local-admin",
        subject: "demo-ui",
        aud: "http://localhost:8787/aimtp",
        iat: 1,
        exp: 2,
        scopes: [{ action: "intentos.read", resource: "intentos:intents" }]
      }
    ],
    signature: {
      alg: "ed25519",
      kid: "local-admin",
      sig: "ZmFrZQ=="
    }
  };
  assert.deepStrictEqual(validateCapabilityShape(sampleCapability), { ok: true, error: "" });
  assert.strictEqual(
    loadCapabilityFromInput(JSON.stringify(sampleCapability)).ok,
    true
  );
  const loadedHeaders = buildIntentosRequestHeaders();
  assert.strictEqual(
    loadedHeaders["X-AIMTP-Capability"],
    JSON.stringify(canonicalizeJsonValue(sampleCapability))
  );
  assert.strictEqual(loadCapabilityFromInput("").ok, true);
  const clearedHeaders = buildIntentosRequestHeaders();
  assert.strictEqual(clearedHeaders["X-AIMTP-Capability"], undefined);

  // The relay requires an API key on IntentOS reads, so the UI must be able to
  // send one alongside any capability.
  assert.strictEqual(buildIntentosRequestHeaders()["X-AIMTP-KEY"], undefined);
  setApiKey(TEST_API_KEY);
  assert.strictEqual(buildIntentosRequestHeaders()["X-AIMTP-KEY"], TEST_API_KEY);
  setApiKey("  " + TEST_API_KEY + "  ");
  assert.strictEqual(
    buildIntentosRequestHeaders()["X-AIMTP-KEY"],
    TEST_API_KEY,
    "surrounding whitespace is trimmed"
  );
  setApiKey("");
  assert.strictEqual(
    buildIntentosRequestHeaders()["X-AIMTP-KEY"],
    undefined,
    "clearing the key drops the header"
  );

  const ranOn = await withServer(
    {
      INTENTOS: "on",
      INTENTOS_MODE: "log",
      AIMTP_API_KEY: TEST_API_KEY
    },
    async (port) => {
      const index = await getText(port, "/intentos/ui");
      assert.strictEqual(index.status, 200);
      assert.ok(index.body.includes("<title>IntentOS Inbox</title>"));
      assert.ok(index.body.includes('href="/intentos/ui/styles.css"'));
      assert.ok(index.body.includes('src="/intentos/ui/app.js"'));
      assert.ok(
        String(index.headers["content-type"] || "").startsWith("text/html"),
        "expected html content-type"
      );

      const indexSlash = await getText(port, "/intentos/ui/");
      assert.strictEqual(indexSlash.status, 200);
      assert.ok(indexSlash.body.includes("<title>IntentOS Inbox</title>"));

      const app = await getText(port, "/intentos/ui/app.js");
      assert.strictEqual(app.status, 200);
      assert.ok(app.body.includes("const POLL_INTERVAL_MS"));
      assert.ok(app.body.includes("const INTENTOS_API_BASE = deriveIntentosApiBase"));
      assert.ok(
        String(app.headers["content-type"] || "").startsWith("application/javascript"),
        "expected javascript content-type"
      );

      const styles = await getText(port, "/intentos/ui/styles.css");
      assert.strictEqual(styles.status, 200);
      assert.ok(styles.body.includes(":root"));
      assert.ok(
        String(styles.headers["content-type"] || "").startsWith("text/css"),
        "expected css content-type"
      );
      const baseIndex = await getText(port, "/aimtp/intentos/ui");
      assert.strictEqual(baseIndex.status, 200);
      assert.ok(baseIndex.body.includes("<title>IntentOS Inbox</title>"));
      assert.ok(baseIndex.body.includes('href="/aimtp/intentos/ui/styles.css"'));
      assert.ok(baseIndex.body.includes('src="/aimtp/intentos/ui/app.js"'));

      const baseIndexSlash = await getText(port, "/aimtp/intentos/ui/");
      assert.strictEqual(baseIndexSlash.status, 200);
      assert.ok(baseIndexSlash.body.includes("<title>IntentOS Inbox</title>"));

      const baseApp = await getText(port, "/aimtp/intentos/ui/app.js");
      assert.strictEqual(baseApp.status, 200);
      assert.ok(baseApp.body.includes("const POLL_INTERVAL_MS"));
      assert.ok(baseApp.body.includes("const INTENTOS_API_BASE = deriveIntentosApiBase"));

      const baseStyles = await getText(port, "/aimtp/intentos/ui/styles.css");
      assert.strictEqual(baseStyles.status, 200);
      assert.ok(baseStyles.body.includes(":root"));

      // UI assets stay unauthenticated; the data endpoints behind them do not.
      const unauthenticated = await getText(port, "/intentos/intents");
      assert.strictEqual(unauthenticated.status, 401, "intents require an API key");
      assert.strictEqual(JSON.parse(unauthenticated.body).code, "unauthorized");

      const wrongKey = await getText(port, "/intentos/intents", {
        headers: { "X-AIMTP-KEY": "wrong-key" }
      });
      assert.strictEqual(wrongKey.status, 403, "a bad API key is rejected");
      assert.strictEqual(JSON.parse(wrongKey.body).code, "forbidden");

      const unauthenticatedTasks = await getText(port, "/intentos/tasks");
      assert.strictEqual(unauthenticatedTasks.status, 401, "tasks require an API key");

      const intents = await getText(port, "/intentos/intents", { headers: AUTH_HEADERS });
      assert.strictEqual(intents.status, 200);
      assert.ok(Array.isArray(JSON.parse(intents.body).intents));

      const tasks = await getText(port, "/intentos/tasks", { headers: AUTH_HEADERS });
      assert.strictEqual(tasks.status, 200);
      assert.ok(Array.isArray(JSON.parse(tasks.body).tasks));

      const baseIntents = await getText(port, "/aimtp/intentos/intents", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(baseIntents.status, 200);
      assert.ok(Array.isArray(JSON.parse(baseIntents.body).intents));

      const baseTasks = await getText(port, "/aimtp/intentos/tasks", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(baseTasks.status, 200);
      assert.ok(Array.isArray(JSON.parse(baseTasks.body).tasks));

      const unknownIntent = await getText(port, "/aimtp/intentos/intent/nope", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(unknownIntent.status, 404, "unknown intent ids are 404");
    },
    { path: "/aimtp" }
  );

  if (!ranOn) {
    return;
  }

  const ranOnTrailing = await withServer(
    {
      INTENTOS: "on",
      INTENTOS_MODE: "log",
      AIMTP_API_KEY: TEST_API_KEY
    },
    async (port) => {
      const index = await getText(port, "/intentos/ui");
      assert.strictEqual(index.status, 200);
      assert.ok(index.body.includes("<title>IntentOS Inbox</title>"));
      assert.ok(index.body.includes('href="/intentos/ui/styles.css"'));
      assert.ok(index.body.includes('src="/intentos/ui/app.js"'));

      const baseIndex = await getText(port, "/aimtp/intentos/ui");
      assert.strictEqual(baseIndex.status, 200);
      assert.ok(baseIndex.body.includes("<title>IntentOS Inbox</title>"));
      assert.ok(baseIndex.body.includes('href="/aimtp/intentos/ui/styles.css"'));
      assert.ok(baseIndex.body.includes('src="/aimtp/intentos/ui/app.js"'));

      const baseApp = await getText(port, "/aimtp/intentos/ui/app.js");
      assert.strictEqual(baseApp.status, 200);
      assert.ok(baseApp.body.includes("const POLL_INTERVAL_MS"));

      const baseIntents = await getText(port, "/aimtp/intentos/intents", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(baseIntents.status, 200);
      assert.ok(Array.isArray(JSON.parse(baseIntents.body).intents));

      const baseTasks = await getText(port, "/aimtp/intentos/tasks", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(baseTasks.status, 200);
      assert.ok(Array.isArray(JSON.parse(baseTasks.body).tasks));
    },
    { path: "/aimtp/" }
  );

  if (!ranOnTrailing) {
    return;
  }

  const keyPair = generateEd25519PemKeyPair();
  const ranEnforce = await withServer(
    {
      INTENTOS: "on",
      AIMTP_API_KEY: TEST_API_KEY,
      INTENTOS_MODE: "enforce",
      AIMTP_CAPABILITIES: "on",
      AIMTP_CAP_MODE: "enforce",
      AIMTP_CAP_PUBLIC_KEY: keyPair.publicKey
    },
    async (port) => {
      const aud = `http://127.0.0.1:${port}/aimtp`;
      const readPresentation = mintCapabilityPresentation({
        issuer: "local-admin",
        subject: "demo-ui",
        aud,
        ttlSec: 900,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        scopes: [
          { action: "intentos.read", resource: "intentos:intents" },
          { action: "intentos.read", resource: "intentos:tasks" }
        ]
      });
      const detailPresentation = mintCapabilityPresentation({
        issuer: "local-admin",
        subject: "demo-ui",
        aud,
        ttlSec: 900,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        scopes: [
          {
            action: "intentos.read",
            resource: "intentos:intent/demo-intent-001"
          }
        ]
      });

      // Authentication runs before capability checks, so these carry the key
      // and are rejected purely for the missing capability.
      const missingIntents = await getText(port, "/aimtp/intentos/intents", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(missingIntents.status, 403);
      assert.strictEqual(JSON.parse(missingIntents.body).code, "capability_required");

      const missingTasks = await getText(port, "/aimtp/intentos/tasks", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(missingTasks.status, 403);
      assert.strictEqual(JSON.parse(missingTasks.body).code, "capability_required");

      const missingDetail = await getText(port, "/aimtp/intentos/intent/demo-intent-001", {
        headers: AUTH_HEADERS
      });
      assert.strictEqual(missingDetail.status, 403);
      assert.strictEqual(JSON.parse(missingDetail.body).code, "capability_required");

      const readHeaders = Object.assign({}, AUTH_HEADERS, {
        "X-AIMTP-Capability": JSON.stringify(readPresentation)
      });

      const allowedIntents = await getText(port, "/aimtp/intentos/intents", {
        headers: readHeaders
      });
      assert.strictEqual(allowedIntents.status, 200);
      assert.ok(Array.isArray(JSON.parse(allowedIntents.body).intents));

      const allowedTasks = await getText(port, "/aimtp/intentos/tasks", {
        headers: readHeaders
      });
      assert.strictEqual(allowedTasks.status, 200);
      assert.ok(Array.isArray(JSON.parse(allowedTasks.body).tasks));

      const deniedDetail = await getText(port, "/aimtp/intentos/intent/demo-intent-001", {
        headers: readHeaders
      });
      assert.strictEqual(deniedDetail.status, 403);
      assert.strictEqual(JSON.parse(deniedDetail.body).code, "capability_invalid");

      const detailHeaders = Object.assign({}, AUTH_HEADERS, {
        "X-AIMTP-Capability": JSON.stringify(detailPresentation)
      });
      const allowedDetail = await getText(port, "/aimtp/intentos/intent/demo-intent-001", {
        headers: detailHeaders
      });
      assert.strictEqual(allowedDetail.status, 404);
      assert.strictEqual(JSON.parse(allowedDetail.body).code, "not_found");
    },
    { path: "/aimtp" }
  );

  if (!ranEnforce) {
    return;
  }

  const ranOff = await withServer(
    {
      INTENTOS: "off",
      INTENTOS_MODE: "log"
    },
    async (port) => {
      const index = await getText(port, "/intentos/ui");
      assert.strictEqual(index.status, 404);
      const baseIndex = await getText(port, "/aimtp/intentos/ui");
      assert.strictEqual(baseIndex.status, 404);
      const baseIntents = await getText(port, "/aimtp/intentos/intents");
      assert.strictEqual(baseIntents.status, 404);
      const baseTasks = await getText(port, "/aimtp/intentos/tasks");
      assert.strictEqual(baseTasks.status, 404);
    },
    { path: "/aimtp" }
  );

  if (!ranOff) {
    return;
  }

  const ranOffTrailing = await withServer(
    {
      INTENTOS: "off",
      INTENTOS_MODE: "log"
    },
    async (port) => {
      const index = await getText(port, "/intentos/ui");
      assert.strictEqual(index.status, 404);

      const baseIndex = await getText(port, "/aimtp/intentos/ui");
      assert.strictEqual(baseIndex.status, 404);
      const baseIntents = await getText(port, "/aimtp/intentos/intents");
      assert.strictEqual(baseIntents.status, 404);
      const baseTasks = await getText(port, "/aimtp/intentos/tasks");
      assert.strictEqual(baseTasks.status, 404);
    },
    { path: "/aimtp/" }
  );

  if (!ranOffTrailing) {
    return;
  }

  console.log("OK: intentos ui tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
