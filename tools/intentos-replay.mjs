#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const HELP = `IntentOS Replay CLI

Usage:
  node tools/intentos-replay.mjs --envelope <path> [options]

Options:
  --envelope <path>       Required. Envelope JSON file
  --record <path>         Optional. ExecutionRecord JSON file
  --receipt-jsonl <path>  Optional. JSONL receipt sink to scan
  --id <envelopeId>       Optional. Envelope id override for lookup
  --strict                Optional. Exit non-zero when observed receipts mismatch expectations
  --json                  Optional. Emit JSON summary
  --help                  Show this help
`;

const TERMINAL_RECEIPTS_BY_STATE = Object.freeze({
  Admitted: ["receipt.admitted"],
  Denied: ["receipt.denied"],
  Completed: ["receipt.completed"],
  Failed: ["receipt.failed"]
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "json" || key === "help" || key === "strict") {
      options[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;
    options[key] = value;
  }

  return options;
}

async function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function readJsonl(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL at line ${index + 1}: ${message}`);
      }
    });
}

function loadIntentosExecutionModule() {
  const distPath = path.resolve(__dirnameFromImportMeta(), "../dist/protocol/intentos-execution.js");
  try {
    return require(distPath);
  } catch {
    throw new Error("Missing dist/protocol/intentos-execution.js. Run: npm run build");
  }
}

function __dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function normalizeRecordState(value) {
  if (typeof value !== "string") {
    return null;
  }
  const known = ["Enqueued", "Admitted", "Denied", "Dispatched", "Completed", "Failed"];
  return known.includes(value) ? value : null;
}

function summarizeExpectedReceipts({ recordState, admissionAllowed }) {
  if (recordState && TERMINAL_RECEIPTS_BY_STATE[recordState]) {
    return {
      source: "record-state",
      expectedTypes: [...TERMINAL_RECEIPTS_BY_STATE[recordState]],
      note: "Derived from execution record terminal state"
    };
  }

  if (recordState === "Enqueued" || recordState === "Dispatched") {
    return {
      source: "record-state",
      expectedTypes: [],
      note: "Record is non-terminal; no terminal receipt is implied yet"
    };
  }

  if (admissionAllowed) {
    return {
      source: "predicate",
      expectedTypes: ["receipt.admitted"],
      note: "Admission replays as allowed; without handler output, completed/failed cannot be predicted"
    };
  }

  return {
    source: "predicate",
    expectedTypes: ["receipt.denied"],
    note: "Admission replays as denied"
  };
}

function selectMatchingReceipts(entries, envelopeId, intentId) {
  return entries.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return entry.envelopeId === envelopeId && entry.intentId === intentId;
  });
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function compareExpectedObserved(expectedTypes, observedTypes) {
  const missing = expectedTypes.filter((type) => !observedTypes.includes(type));
  const extra = observedTypes.filter((type) => !expectedTypes.includes(type));
  return {
    missing,
    extra,
    match: missing.length === 0
  };
}

function printHumanSummary(summary) {
  const lines = [];
  lines.push("IntentOS Receipt Replay Summary");
  lines.push(`- envelopeId: ${summary.envelopeId}`);
  lines.push(`- intentId: ${summary.intentId}`);
  lines.push(`- admission: ${summary.admissionAllowed ? "admit" : "deny"}`);
  lines.push(`- dispatch_possible: ${summary.dispatchPossible ? "yes" : "no"}`);
  lines.push(`- record_state: ${summary.recordState || "(none)"}`);
  lines.push(`- expected_receipts: ${summary.expectedReceiptTypes.join(", ") || "(none)"}`);
  lines.push(`- expectation_note: ${summary.expectationNote}`);

  if (summary.observed) {
    lines.push(`- observed_receipts: ${summary.observed.types.join(", ") || "(none)"}`);
    lines.push(`- observed_count: ${summary.observed.count}`);
    lines.push(
      `- observed_match: ${summary.observed.comparison.match ? "yes" : "no"}`
    );
    if (summary.observed.comparison.missing.length > 0) {
      lines.push(`- missing_expected: ${summary.observed.comparison.missing.join(", ")}`);
    }
    if (summary.observed.comparison.extra.length > 0) {
      lines.push(`- extra_observed: ${summary.observed.comparison.extra.join(", ")}`);
    }
  }

  if (summary.warnings.length > 0) {
    lines.push(`- warnings: ${summary.warnings.join(" | ")}`);
  }

  console.log(lines.join("\n"));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${message}\n\n${HELP}`);
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!options.envelope) {
    fail(`--envelope is required\n\n${HELP}`);
  }
  if (options.strict && !options["receipt-jsonl"]) {
    fail("--strict requires --receipt-jsonl");
  }

  const { canAdmit, canDispatch } = loadIntentosExecutionModule();

  const warnings = [];
  const envelope = await readJson(options.envelope);
  const record = options.record ? await readJson(options.record) : null;

  const envelopeId =
    typeof options.id === "string" && options.id.trim().length > 0
      ? options.id.trim()
      : envelope?.id;
  const intentId = envelope?.intent?.id;

  if (!envelopeId || typeof envelopeId !== "string") {
    fail("Unable to derive envelopeId (check --id or envelope.id)");
  }
  if (!intentId || typeof intentId !== "string") {
    fail("Unable to derive intentId from envelope.intent.id");
  }

  const admissionAllowed = Boolean(canAdmit(envelope, envelope.intent));
  const dispatchPossible = Boolean(canDispatch(envelope, envelope.intent));

  const recordState = normalizeRecordState(record?.state);
  if (record && !recordState) {
    warnings.push("Execution record state is missing or unknown");
  }
  if (record?.envelopeId && record.envelopeId !== envelopeId) {
    warnings.push("ExecutionRecord envelopeId does not match lookup envelopeId");
  }
  if (record?.intentId && record.intentId !== intentId) {
    warnings.push("ExecutionRecord intentId does not match envelope.intent.id");
  }
  if (recordState === "Denied" && admissionAllowed) {
    warnings.push("Record is Denied but admission predicate currently returns admit");
  }

  const expected = summarizeExpectedReceipts({
    recordState,
    admissionAllowed
  });

  let observed = null;
  if (options["receipt-jsonl"]) {
    const entries = await readJsonl(options["receipt-jsonl"]);
    const matches = selectMatchingReceipts(entries, envelopeId, intentId);
    const observedTypes = uniqueSorted(
      matches
        .map((entry) => (typeof entry?.type === "string" ? entry.type : ""))
        .filter((type) => type.length > 0)
    );
    observed = {
      count: matches.length,
      types: observedTypes,
      comparison: compareExpectedObserved(expected.expectedTypes, observedTypes)
    };
  }

  const summary = {
    envelopeId,
    intentId,
    admissionAllowed,
    dispatchPossible,
    recordState,
    expectedReceiptTypes: expected.expectedTypes,
    expectationNote: expected.note,
    observed,
    warnings
  };

  let strictFailure = null;
  if (options.strict) {
    if (!observed) {
      strictFailure = "Strict mode requires observed receipts.";
    } else if (!observed.comparison.match) {
      const details = [];
      if (observed.comparison.missing.length > 0) {
        details.push(`missing expected: ${observed.comparison.missing.join(", ")}`);
      }
      if (observed.comparison.extra.length > 0) {
        details.push(`unexpected observed: ${observed.comparison.extra.join(", ")}`);
      }
      strictFailure = `Observed receipts mismatch expected receipts (${details.join("; ") || "unknown mismatch"})`;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    if (strictFailure) {
      fail(strictFailure);
    }
    return;
  }

  printHumanSummary(summary);
  if (strictFailure) {
    fail(strictFailure);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
