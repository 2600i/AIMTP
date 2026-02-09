"use strict";

const { AgentRegistry } = require("./registry");
const { validateEnvelope } = require("./validation");

class RelayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class WebhookRelay {
  constructor(options = {}) {
    this.registry = options.registry || new AgentRegistry();
    this.defaultRecipient = options.defaultRecipient;
    this.emitResponses = options.emitResponses !== false;
    this.logger = options.logger || null;
  }

  registerAgent(agentId, handler) {
    this.registry.register(agentId, handler);
  }

  unregisterAgent(agentId) {
    this.registry.unregister(agentId);
  }

  async receive(envelope) {
    const errors = validateEnvelope(envelope);
    if (errors.length > 0) {
      throw new RelayError("invalid_envelope", "Envelope failed schema validation", { errors });
    }

    const recipient = envelope.recipient || this.defaultRecipient;
    if (!recipient) {
      throw new RelayError("missing_recipient", "Recipient is required");
    }

    const handler = this.registry.get(recipient);
    if (!handler) {
      throw new RelayError("unknown_recipient", `Unknown recipient: ${recipient}`, {
        recipient
      });
    }

    const responses = [];
    const context = {
      sender: envelope.sender,
      recipient,
      task: envelope.task,
      metadata: envelope.metadata,
      emit: (responseEnvelope) => {
        responses.push(responseEnvelope);
      }
    };

    let handlerResult;
    try {
      handlerResult = await handler(envelope, context);
    } catch (err) {
      if (this.logger && typeof this.logger.log === "function") {
        this.logger.log(`handler error: ${err.message || err}`);
      }
      throw new RelayError("handler_error", "Handler raised an error", {
        recipient,
        message: err.message || String(err)
      });
    }

    const isDefaultHandler = handler && handler.__aimtpDefault === true;
    if (!isDefaultHandler) {
      for (const response of responses) {
        const responseErrors = validateEnvelope(response);
        if (responseErrors.length > 0) {
          throw new RelayError(
            "invalid_response",
            "Handler emitted an invalid envelope",
            { errors: responseErrors }
          );
        }
      }
    }

    if (isDefaultHandler) {
      return {
        __aimtpAccepted: true,
        status: "accepted",
        id: envelope.id,
        recipient
      };
    }

    if (handlerResult && handlerResult.__aimtpAccepted) {
      return handlerResult;
    }

    return responses;
  }
}

module.exports = {
  RelayError,
  WebhookRelay
};
