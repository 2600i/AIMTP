"use strict";

const { AgentRegistry } = require("./registry");
const { WebhookRelay, RelayError } = require("./relay");
const {
  Mailbox,
  InMemoryMailboxStore,
  SQLiteMailboxStore,
  RedisMailboxStore,
  createMailboxStore,
  parseMailboxStoreType
} = require("./mailbox");
const { createWebhookRelayServer } = require("./http");
const { validateEnvelope, validateMessage, validateTask, SPEC_VERSION } = require("./validation");

module.exports = {
  AgentRegistry,
  WebhookRelay,
  RelayError,
  Mailbox,
  InMemoryMailboxStore,
  SQLiteMailboxStore,
  RedisMailboxStore,
  createMailboxStore,
  parseMailboxStoreType,
  createWebhookRelayServer,
  validateEnvelope,
  validateMessage,
  validateTask,
  SPEC_VERSION
};
