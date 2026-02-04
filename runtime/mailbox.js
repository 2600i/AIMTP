"use strict";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_MAX_RECIPIENTS = 1000;

class Mailbox {
  constructor(options = {}) {
    this.ttlMs =
      typeof options.ttlMs === "number" && options.ttlMs > 0
        ? options.ttlMs
        : DEFAULT_TTL_MS;
    this.maxQueueLength =
      typeof options.maxQueueLength === "number" && options.maxQueueLength > 0
        ? options.maxQueueLength
        : DEFAULT_MAX_QUEUE_LENGTH;
    this.maxRecipients =
      typeof options.maxRecipients === "number" && options.maxRecipients > 0
        ? options.maxRecipients
        : DEFAULT_MAX_RECIPIENTS;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || null;
    this.mailboxes = new Map();
  }

  enqueue(recipient, envelope) {
    const now = this.now();
    let mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      mailbox = { queue: [], lastActivity: now };
      this.mailboxes.set(recipient, mailbox);
    }

    this.purgeExpired(mailbox, now);
    mailbox.queue.push({ envelope, enqueuedAt: now });
    mailbox.lastActivity = now;

    let dropped = 0;
    while (mailbox.queue.length > this.maxQueueLength) {
      mailbox.queue.shift();
      dropped += 1;
    }

    if (dropped > 0) {
      this.logDropOldest(recipient, dropped, mailbox.queue.length);
    }

    this.ensureRecipientLimit();

    return { queueDepth: mailbox.queue.length, dropped };
  }

  peek(recipient) {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return { count: 0 };
    }
    const now = this.now();
    this.purgeExpired(mailbox, now);
    if (mailbox.queue.length === 0) {
      this.mailboxes.delete(recipient);
      return { count: 0 };
    }
    mailbox.lastActivity = now;
    return { count: mailbox.queue.length };
  }

  poll(recipient, maxItems) {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return [];
    }
    const now = this.now();
    this.purgeExpired(mailbox, now);

    const count = Math.min(maxItems, mailbox.queue.length);
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const entry = mailbox.queue.shift();
      if (entry) {
        items.push(entry.envelope);
      }
    }

    if (mailbox.queue.length === 0) {
      this.mailboxes.delete(recipient);
    } else {
      mailbox.lastActivity = now;
    }

    return items;
  }

  purgeExpired(mailbox, now) {
    while (mailbox.queue.length > 0) {
      const entry = mailbox.queue[0];
      if (now - entry.enqueuedAt < this.ttlMs) {
        break;
      }
      mailbox.queue.shift();
    }
  }

  ensureRecipientLimit() {
    if (this.mailboxes.size <= this.maxRecipients) {
      return;
    }

    for (const [recipient, mailbox] of this.mailboxes.entries()) {
      if (mailbox.queue.length === 0) {
        this.mailboxes.delete(recipient);
      }
    }

    if (this.mailboxes.size <= this.maxRecipients) {
      return;
    }

    const entries = Array.from(this.mailboxes.entries()).sort(
      (a, b) => a[1].lastActivity - b[1].lastActivity
    );

    for (const [recipient] of entries) {
      if (this.mailboxes.size <= this.maxRecipients) {
        break;
      }
      this.mailboxes.delete(recipient);
    }
  }

  logDropOldest(recipient, dropped, queueDepth) {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

module.exports = {
  Mailbox
};
