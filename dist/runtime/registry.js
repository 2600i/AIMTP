"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
class AgentRegistry {
    constructor() {
        this.agents = new Map();
    }
    register(agent, handler) {
        if (!agent.id || agent.id.trim() === "") {
            throw new Error("Agent id is required");
        }
        if (this.agents.has(agent.id)) {
            throw new Error(`Agent already registered: ${agent.id}`);
        }
        this.agents.set(agent.id, { agent, handler });
    }
    unregister(agentId) {
        this.agents.delete(agentId);
    }
    get(agentId) {
        return this.agents.get(agentId);
    }
    list() {
        return Array.from(this.agents.values(), ({ agent }) => agent);
    }
}
exports.AgentRegistry = AgentRegistry;
