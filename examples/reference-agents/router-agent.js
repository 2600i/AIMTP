"use strict";

function readIntent(intentValue) {
  if (typeof intentValue === "string") {
    return { type: intentValue, priority: "normal" };
  }
  if (!intentValue || typeof intentValue !== "object") {
    return { type: "task.request", priority: "normal" };
  }
  return {
    type: typeof intentValue.type === "string" && intentValue.type.trim() ? intentValue.type : "task.request",
    priority: intentValue.priority === undefined ? "normal" : intentValue.priority
  };
}

function numericPriority(priority) {
  if (Number.isInteger(priority)) {
    return Math.max(0, Math.min(100, priority));
  }
  if (priority === "low") {
    return 25;
  }
  if (priority === "high") {
    return 75;
  }
  if (priority === "urgent") {
    return 100;
  }
  return 50;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function extractRequiredCapabilities(envelope) {
  const required = new Set();
  const addValues = (values) => {
    normalizeArray(values).forEach((value) => required.add(value));
  };

  addValues(envelope && envelope.capabilities && envelope.capabilities.required);
  addValues(
    envelope &&
      envelope.message &&
      envelope.message.capabilities &&
      envelope.message.capabilities.required
  );

  const actionCapabilities = [];
  const actions = envelope && envelope.actions;
  if (Array.isArray(actions)) {
    actions.forEach((action) => {
      if (action && typeof action.type === "string" && action.type.trim()) {
        actionCapabilities.push(action.type.trim());
      }
    });
  }
  addValues(actionCapabilities);

  return Array.from(required);
}

class ReferenceRouterAgent {
  constructor(options = {}) {
    this.id = options.id || "agent-router";
    this.executors = Array.isArray(options.executors) ? options.executors.slice() : [];
    this.defaultRecipient =
      typeof options.defaultRecipient === "string" && options.defaultRecipient.trim()
        ? options.defaultRecipient.trim()
        : "";
  }

  describeDecision(envelope) {
    const intent = readIntent(envelope && envelope.intent);
    const required = extractRequiredCapabilities(envelope);
    const priorityScore = numericPriority(intent.priority);
    const candidates = this.executors
      .map((executor) => {
        const capabilities = normalizeArray(executor.capabilities);
        const matched = required.filter((capability) => capabilities.includes(capability));
        const supportsAll = required.length === 0 || matched.length === required.length;
        const baseScore = Number.isFinite(executor.basePriority) ? Number(executor.basePriority) : 0;
        const score = matched.length * 100 + priorityScore + baseScore;
        return {
          recipient: executor.recipient,
          capabilities,
          matched,
          supportsAll,
          score
        };
      })
      .filter((candidate) => typeof candidate.recipient === "string" && candidate.recipient.trim() !== "");

    const supported = candidates
      .filter((candidate) => candidate.supportsAll)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.recipient.localeCompare(b.recipient);
      });

    if (supported.length > 0) {
      return {
        decision: "route",
        recipient: supported[0].recipient,
        required_capabilities: required,
        priority_score: priorityScore
      };
    }

    const offeredSet = new Set();
    candidates.forEach((candidate) => {
      candidate.capabilities.forEach((capability) => offeredSet.add(capability));
    });
    return {
      decision: "negotiate",
      recipient: null,
      required_capabilities: required,
      offered_capabilities: Array.from(offeredSet).sort(),
      priority_score: priorityScore
    };
  }

  buildForwardEnvelope(sourceEnvelope, recipient) {
    const metadata = Object.assign({}, sourceEnvelope.metadata || {});
    metadata.aimtp = Object.assign({}, metadata.aimtp || {}, {
      routed_by: this.id,
      original_envelope_id: sourceEnvelope.id,
      original_sender: sourceEnvelope.sender
    });
    return {
      spec: sourceEnvelope.spec,
      id: `${sourceEnvelope.id}:route:${recipient}`,
      timestamp: new Date().toISOString(),
      sender: this.id,
      recipient,
      intent: sourceEnvelope.intent,
      actions: sourceEnvelope.actions,
      capabilities: sourceEnvelope.capabilities,
      negotiation: sourceEnvelope.negotiation,
      message: sourceEnvelope.message,
      task: sourceEnvelope.task,
      metadata
    };
  }

  buildNegotiationEnvelope(sourceEnvelope, offeredCapabilities) {
    const sender = sourceEnvelope && typeof sourceEnvelope.sender === "string" ? sourceEnvelope.sender : "";
    if (!sender) {
      return null;
    }
    return {
      spec: sourceEnvelope.spec,
      id: `${sourceEnvelope.id}:negotiation`,
      timestamp: new Date().toISOString(),
      sender: this.id,
      recipient: sender,
      intent: {
        type: "task.update",
        priority: "normal",
        tags: ["negotiation"]
      },
      message: {
        id: `msg-${sourceEnvelope.id}-negotiation`,
        role: "assistant",
        content: "Capability mismatch detected. Counter-offer attached."
      },
      negotiation: {
        counter: {
          required: extractRequiredCapabilities(sourceEnvelope),
          offered: offeredCapabilities
        },
        reject: false
      },
      capabilities: {
        offered: offeredCapabilities
      },
      metadata: Object.assign({}, sourceEnvelope.metadata || {}, {
        aimtp: Object.assign({}, (sourceEnvelope.metadata && sourceEnvelope.metadata.aimtp) || {}, {
          original_envelope_id: sourceEnvelope.id,
          negotiation: true
        })
      })
    };
  }

  async handleEnvelope(envelope) {
    const decision = this.describeDecision(envelope);
    if (decision.decision === "route") {
      return {
        decision,
        outbound: [this.buildForwardEnvelope(envelope, decision.recipient)]
      };
    }

    const negotiationEnvelope = this.buildNegotiationEnvelope(
      envelope,
      decision.offered_capabilities || []
    );
    if (!negotiationEnvelope) {
      return { decision, outbound: [] };
    }
    return {
      decision,
      outbound: [negotiationEnvelope]
    };
  }
}

module.exports = {
  ReferenceRouterAgent,
  extractRequiredCapabilities,
  readIntent
};
