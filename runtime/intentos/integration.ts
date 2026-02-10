import {
  Envelope,
  ExecutionRecord,
  Intent,
  IntentHandler,
  markDenied,
  fireDispatch,
  INVALID_EXAMPLE_ENV,
  VALID_EXAMPLE_ENV
} from "../../src/protocol/intentos-execution";

// In-memory registry that maps AIMTP recipients to Intent handlers.
const intentHandlerRegistry = new Map<string, IntentHandler>();

// Register (or replace) the handler responsible for one recipient.
export function registerIntentHandler(recipient: string, handler: IntentHandler): void {
  intentHandlerRegistry.set(recipient, handler);
}

// Process one AIMTP envelope:
// 1) find recipient handler
// 2) run semantics dispatch when handler exists
// 3) otherwise return a Denied record with a fixed reason
// 4) log the resulting record
export async function handleAIMTPEnvelope(env: Envelope): Promise<ExecutionRecord> {
  const msg: Intent = env.intent;
  const handler = intentHandlerRegistry.get(env.recipient);

  let record: ExecutionRecord;
  if (!handler) {
    record = markDenied(env, msg, "no-handler-registered");
  } else {
    record = await fireDispatch(env, msg, handler);
  }

  console.log(JSON.stringify(record, null, 2));
  return record;
}

// Minimal runnable demo for v1 integration.
export async function main(): Promise<void> {
  // Register one example handler for calendar recipient.
  registerIntentHandler("agent://calendar", async (intent) => {
    return {
      ok: true,
      booked: intent.payload
    };
  });

  // Simulate valid delivery.
  await handleAIMTPEnvelope(VALID_EXAMPLE_ENV);

  // Simulate invalid delivery.
  await handleAIMTPEnvelope(INVALID_EXAMPLE_ENV);
}

// Run demo when invoked directly from Node after compilation.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/*
README SNIPPET

How to run:
1) Compile this file:
   npx tsc runtime/intentos/integration.ts --module commonjs --target ES2020 --outDir dist
2) Run:
   node dist/runtime/intentos/integration.js

Expected output shape:
- Valid run (VALID_EXAMPLE_ENV):
  {
    "state": "Completed",
    "decision": { "verdict": "ADMIT", "reason": "capability-scope-match" },
    "output": { "ok": true, "booked": { ... } }
  }

- Invalid run (INVALID_EXAMPLE_ENV):
  {
    "state": "Denied",
    "decision": { "verdict": "DENY", "reason": "action-not-permitted" },
    "error": "action-not-permitted"
  }

IntentOS v1 execution semantics — frozen
*/
