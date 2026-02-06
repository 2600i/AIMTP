"use strict";

const { LocalStubLLMAdapter } = require("./llm-adapter");

function resolveActions(envelope) {
  if (Array.isArray(envelope && envelope.actions)) {
    return envelope.actions;
  }
  if (Array.isArray(envelope && envelope.message && envelope.message.actions)) {
    return envelope.message.actions;
  }
  return [];
}

function resolveResponseRecipient(envelope) {
  const fromMetadata =
    envelope &&
    envelope.metadata &&
    envelope.metadata.aimtp &&
    typeof envelope.metadata.aimtp.original_sender === "string"
      ? envelope.metadata.aimtp.original_sender.trim()
      : "";
  if (fromMetadata) {
    return fromMetadata;
  }
  return typeof envelope.sender === "string" ? envelope.sender : "";
}

class ReferenceExecutorAgent {
  constructor(options = {}) {
    this.id = options.id || "agent-executor";
    this.adapter = options.adapter || new LocalStubLLMAdapter();
    this.supportedActions = new Set(
      Array.isArray(options.supportedActions)
        ? options.supportedActions
        : ["summarize", "extract", "validate_schema", "format"]
    );
    this.cache = new Map();
  }

  async runActions(envelope) {
    const actions = resolveActions(envelope);
    if (actions.length === 0) {
      return [];
    }

    const outputs = [];
    for (const action of actions) {
      const actionType = action && typeof action.type === "string" ? action.type.trim() : "";
      if (!actionType || !this.supportedActions.has(actionType)) {
        throw new Error(`unsupported_action:${actionType || "unknown"}`);
      }
      const result = await this.adapter.runAction(action, {
        envelopeId: envelope.id,
        agentId: this.id
      });
      outputs.push({
        id: action.id,
        type: actionType,
        result
      });
    }
    return outputs;
  }

  buildSuccessEnvelope(requestEnvelope, outputs, idempotent) {
    const responseRecipient = resolveResponseRecipient(requestEnvelope);
    return {
      spec: requestEnvelope.spec,
      id: `${requestEnvelope.id}:result:${this.id}`,
      timestamp: new Date().toISOString(),
      sender: this.id,
      recipient: responseRecipient,
      intent: "task.response",
      message: {
        id: `msg-${requestEnvelope.id}-result`,
        role: "assistant",
        content: {
          status: "succeeded",
          outputs,
          idempotent
        }
      },
      task:
        requestEnvelope.task && requestEnvelope.task.kind === "request"
          ? {
              kind: "response",
              id: `${requestEnvelope.task.id}-response`,
              in_response_to: requestEnvelope.task.id,
              status: "succeeded",
              output: {
                outputs,
                idempotent
              }
            }
          : undefined,
      metadata: Object.assign({}, requestEnvelope.metadata || {}, {
        aimtp: Object.assign({}, (requestEnvelope.metadata && requestEnvelope.metadata.aimtp) || {}, {
          processed_by: this.id,
          source_envelope_id: requestEnvelope.id
        })
      })
    };
  }

  async handleEnvelope(envelope) {
    const cached = this.cache.get(envelope.id);
    if (cached) {
      return {
        idempotent: true,
        outbound: []
      };
    }

    const outputs = await this.runActions(envelope);
    const responseEnvelope = this.buildSuccessEnvelope(envelope, outputs, false);
    this.cache.set(envelope.id, responseEnvelope);
    return {
      idempotent: false,
      outbound: [responseEnvelope]
    };
  }
}

module.exports = {
  ReferenceExecutorAgent,
  resolveActions
};
