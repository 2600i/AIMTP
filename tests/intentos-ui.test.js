"use strict";

const assert = require("assert");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

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

function getText(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET"
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
  const ranOn = await withServer(
    {
      INTENTOS: "on",
      INTENTOS_MODE: "log"
    },
    async (port) => {
      const index = await getText(port, "/intentos/ui");
      assert.strictEqual(index.status, 200);
      assert.ok(index.body.includes("<title>IntentOS Inbox</title>"));
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

      const baseIndexSlash = await getText(port, "/aimtp/intentos/ui/");
      assert.strictEqual(baseIndexSlash.status, 200);
      assert.ok(baseIndexSlash.body.includes("<title>IntentOS Inbox</title>"));

      const baseApp = await getText(port, "/aimtp/intentos/ui/app.js");
      assert.strictEqual(baseApp.status, 200);
      assert.ok(baseApp.body.includes("const POLL_INTERVAL_MS"));

      const baseStyles = await getText(port, "/aimtp/intentos/ui/styles.css");
      assert.strictEqual(baseStyles.status, 200);
      assert.ok(baseStyles.body.includes(":root"));
    },
    { path: "/aimtp" }
  );

  if (!ranOn) {
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
    },
    { path: "/aimtp" }
  );

  if (!ranOff) {
    return;
  }

  console.log("OK: intentos ui tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
