"use strict";

class AgentRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(agentId, handler) {
    if (typeof agentId !== "string" || agentId.trim() === "") {
      throw new Error("Agent id is required");
    }
    if (typeof handler !== "function") {
      throw new Error("Handler must be a function");
    }
    if (this.handlers.has(agentId)) {
      throw new Error(`Agent already registered: ${agentId}`);
    }
    this.handlers.set(agentId, handler);
  }

  unregister(agentId) {
    this.handlers.delete(agentId);
  }

  get(agentId) {
    return this.handlers.get(agentId);
  }

  list() {
    return Array.from(this.handlers.keys());
  }
}

module.exports = {
  AgentRegistry
};
