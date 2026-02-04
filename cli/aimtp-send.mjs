#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HELP = `AIMTP CLI sender (v0.1)

Usage:
  node cli/aimtp-send.mjs --url https://relay.aimtp.net/aimtp --api-key <key> --file cli/sample-envelope.json
  node cli/aimtp-send.mjs --json '{"spec":"aimtp/0.1", "message": {"id":"msg_1","role":"user","content":"hi"}}'

Options:
  --url <url>           Relay URL (default: https://relay.aimtp.net/aimtp)
  --api-key <key>       API key (sent as Authorization: Bearer <key>)
  --file <path>         Path to envelope JSON file
  --json <json>         Inline JSON envelope
  --intent <intent>     Override envelope.intent
  --sender <sender>     Override envelope.sender
  --recipient <recip>   Override envelope.recipient
  --message <text>      Override message.content (string)
  --help                Show this help
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'help') {
      out.help = true;
      continue;
    }
    if ([
      'url',
      'api-key',
      'file',
      'json',
      'intent',
      'sender',
      'recipient',
      'message'
    ].includes(key)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      i += 1;
      const normalized = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[normalized] = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureMessage(envelope, contentOverride) {
  if (!isPlainObject(envelope.message)) {
    if (contentOverride === undefined) {
      return;
    }
    envelope.message = {
      id: randomUUID(),
      role: 'user',
      content: contentOverride
    };
    return;
  }
  if (contentOverride !== undefined) {
    envelope.message.content = contentOverride;
    if (!envelope.message.role) {
      envelope.message.role = 'user';
    }
  }
}

function ensureIds(envelope) {
  if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
    envelope.id = randomUUID();
  }
  if (!isPlainObject(envelope.message)) {
    return;
  }
  if (typeof envelope.message.id !== 'string' || envelope.message.id.length === 0) {
    envelope.message.id = randomUUID();
  }
}

function formatAjvErrors(errors) {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((err) => {
    let path = err.instancePath || '/';
    if (err.keyword === 'required' && err.params && err.params.missingProperty) {
      path = `${err.instancePath || ''}/${err.params.missingProperty}` || '/';
    }
    const message = err.message || 'is invalid';
    return `${path}: ${message}`;
  });
}

function extractValidationErrors(body) {
  const lines = [];
  if (!body || typeof body !== 'object') {
    return lines;
  }
  const pushError = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') {
      lines.push(entry);
      return;
    }
    if (typeof entry === 'object') {
      const path = entry.instancePath || entry.path || entry.field || '';
      const message = entry.message || entry.error || JSON.stringify(entry);
      lines.push(path ? `${path}: ${message}` : message);
    }
  };

  if (Array.isArray(body.errors)) {
    body.errors.forEach(pushError);
  }

  if (body.error && typeof body.error === 'object') {
    if (Array.isArray(body.error.details)) {
      body.error.details.forEach(pushError);
    } else if (body.error.details && typeof body.error.details === 'object') {
      const details = body.error.details;
      if (Array.isArray(details.errors)) {
        details.errors.forEach(pushError);
      }
    }
  }

  if (body.validation_errors && Array.isArray(body.validation_errors)) {
    body.validation_errors.forEach(pushError);
  }

  return lines;
}

async function loadSchemas() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const schemaDir = path.resolve(__dirname, '..', 'schemas');

  const [envelopeRaw, messageRaw] = await Promise.all([
    fs.readFile(path.join(schemaDir, 'envelope.schema.json'), 'utf8'),
    fs.readFile(path.join(schemaDir, 'message.schema.json'), 'utf8')
  ]);

  return {
    envelope: JSON.parse(envelopeRaw),
    message: JSON.parse(messageRaw)
  };
}

async function validateEnvelope(envelope) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemas = await loadSchemas();
  ajv.addSchema(schemas.message);
  const validate = ajv.compile(schemas.envelope);
  const valid = validate(envelope);
  return { valid, errors: validate.errors || [] };
}

function printStatus(res) {
  console.log(`HTTP ${res.status} ${res.statusText}`);
  const headerNames = ['date', 'content-type', 'content-length', 'x-request-id'];
  for (const name of headerNames) {
    const value = res.headers.get(name);
    if (value) {
      console.log(`${name}: ${value}`);
    }
  }
  console.log('');
}

function printErrorHint(status) {
  if (status === 401) {
    console.error('Unauthorized (401): check your API key or Authorization header.');
  } else if (status === 403) {
    console.error('Forbidden (403): API key does not have access.');
  } else if (status === 413) {
    console.error('Payload Too Large (413): envelope exceeds relay size limits.');
  } else if (status === 400) {
    console.error('Bad Request (400): envelope failed relay validation.');
  } else if (status >= 500) {
    console.error('Server Error: relay is unavailable or failed to process the request.');
  }
}

async function handleHealthCheck(url) {
  let res;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err) {
    console.error('Network error while sending request.');
    console.error(err.message || String(err));
    process.exitCode = 1;
    return;
  }

  printStatus(res);
  const bodyText = await res.text();
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json') || contentType.includes('+json');

  if (isJson && bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(bodyText);
    }
  } else if (bodyText) {
    console.log(bodyText);
  } else {
    console.log('<empty response body>');
  }

  if (res.status >= 400) {
    printErrorHint(res.status);
    process.exitCode = 1;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message || String(err));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.file && args.json) {
    console.error('Provide only one of --file or --json.');
    process.exitCode = 1;
    return;
  }

  const url = args.url || 'https://relay.aimtp.net/aimtp';
  let isHealthCheck = false;
  try {
    const parsedUrl = new URL(url);
    isHealthCheck = parsedUrl.pathname.endsWith('/healthz');
  } catch {
    isHealthCheck = false;
  }

  if (isHealthCheck) {
    await handleHealthCheck(url);
    return;
  }

  let envelope;
  if (args.file) {
    try {
      const raw = await fs.readFile(args.file, 'utf8');
      envelope = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to read or parse file: ${args.file}`);
      console.error(err.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (args.json) {
    try {
      envelope = JSON.parse(args.json);
    } catch (err) {
      console.error('Failed to parse --json input.');
      console.error(err.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    envelope = {
      spec: 'aimtp/0.1',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: randomUUID(),
        role: 'user',
        content: args.message || 'Hello from AIMTP CLI'
      }
    };
  }

  if (!isPlainObject(envelope)) {
    console.error('Envelope must be a JSON object.');
    process.exitCode = 1;
    return;
  }

  if (!('spec' in envelope) || envelope.spec === null || envelope.spec === '') {
    envelope.spec = 'aimtp/0.1';
  }

  if (args.intent) envelope.intent = args.intent;
  if (args.sender) envelope.sender = args.sender;
  if (args.recipient) envelope.recipient = args.recipient;

  ensureMessage(envelope, args.message);
  ensureIds(envelope);

  envelope.timestamp = new Date().toISOString();

  const { valid, errors } = await validateEnvelope(envelope);
  if (!valid) {
    console.error('Envelope validation failed:');
    const lines = formatAjvErrors(errors);
    if (lines.length === 0) {
      console.error('  Unknown schema error.');
    } else {
      for (const line of lines) {
        console.error(`  - ${line}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  const headers = {
    'content-type': 'application/json'
  };
  if (args.apiKey) {
    headers.authorization = `Bearer ${args.apiKey}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope)
    });
  } catch (err) {
    console.error('Network error while sending request.');
    console.error(err.message || String(err));
    process.exitCode = 1;
    return;
  }

  printStatus(res);

  const bodyText = await res.text();
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json') || contentType.includes('+json');

  let parsed;
  if (isJson && bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
  }

  if (parsed !== undefined) {
    console.log(JSON.stringify(parsed, null, 2));
  } else if (bodyText) {
    console.log(bodyText);
  } else {
    console.log('<empty response body>');
  }

  if (parsed !== undefined) {
    const validationLines = extractValidationErrors(parsed);
    if (validationLines.length > 0) {
      console.error('\nRelay validation errors:');
      for (const line of validationLines) {
        console.error(`  - ${line}`);
      }
    }
  }

  if (res.status >= 400) {
    printErrorHint(res.status);
    process.exitCode = 1;
  }
}

main();
