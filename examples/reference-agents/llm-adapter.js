"use strict";

const { validateEnvelope, validateMessage, validateTask } = require("../../runtime/validation");

class LLMAdapter {
  async runAction(_action, _context = {}) {
    throw new Error("LLMAdapter.runAction must be implemented");
  }
}

function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }
  return String(value);
}

class LocalStubLLMAdapter extends LLMAdapter {
  constructor() {
    super();
    this.calls = [];
  }

  async runAction(action, context = {}) {
    if (!action || typeof action !== "object") {
      throw new Error("action must be an object");
    }
    this.calls.push({
      id: action.id,
      type: action.type,
      inputs: action.inputs,
      envelope_id: context.envelopeId || null
    });

    const type = typeof action.type === "string" ? action.type.trim() : "";
    const inputs = action.inputs && typeof action.inputs === "object" ? action.inputs : {};
    if (!type) {
      throw new Error("action.type is required");
    }

    if (type === "summarize") {
      const text = toText(inputs.text);
      const maxWords =
        Number.isInteger(inputs.max_words) && inputs.max_words > 0 ? inputs.max_words : 12;
      const words = text.split(/\s+/).filter(Boolean);
      return {
        summary: words.slice(0, maxWords).join(" "),
        word_count: words.length
      };
    }

    if (type === "extract") {
      const text = toText(inputs.text);
      const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      const numberMatches = text.match(/-?\d+(?:\.\d+)?/g) || [];
      return {
        email: emailMatch ? emailMatch[0] : null,
        numbers: numberMatches.map((value) => Number(value))
      };
    }

    if (type === "validate_schema") {
      const target = typeof inputs.target === "string" ? inputs.target : "envelope";
      const payload = inputs.payload;
      let errors;
      if (target === "message") {
        errors = validateMessage(payload);
      } else if (target === "task") {
        errors = validateTask(payload);
      } else {
        errors = validateEnvelope(payload);
      }
      return {
        target,
        valid: errors.length === 0,
        errors
      };
    }

    if (type === "format") {
      const value = Object.prototype.hasOwnProperty.call(inputs, "value") ? inputs.value : inputs;
      const style = typeof inputs.style === "string" ? inputs.style : "json";
      if (style === "compact") {
        return { output: JSON.stringify(value) };
      }
      if (style === "text") {
        return { output: toText(value).trim() };
      }
      return { output: JSON.stringify(value, null, 2) };
    }

    throw new Error(`unsupported_action:${type}`);
  }
}

module.exports = {
  LLMAdapter,
  LocalStubLLMAdapter
};
