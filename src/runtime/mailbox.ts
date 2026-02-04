export type MailboxLogger = { log: (message: string) => void } | null;

export type MailboxOptions = {
  ttlMs?: number;
  maxQueueLength?: number;
  maxRecipients?: number;
  now?: () => number;
  logger?: MailboxLogger;
};

type MailboxEntry = {
  envelope: unknown;
  enqueuedAt: number;
};

type RecipientMailbox = {
  queue: MailboxEntry[];
  lastActivity: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_MAX_RECIPIENTS = 1000;

export class Mailbox {
  private ttlMs: number;
  private maxQueueLength: number;
  private maxRecipients: number;
  private now: () => number;
  private logger: MailboxLogger;
  private mailboxes: Map<string, RecipientMailbox>;

  constructor(options: MailboxOptions = {}) {
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
    this.logger = options.logger ?? null;
    this.mailboxes = new Map();
  }

  enqueue(recipient: string, envelope: unknown): { queueDepth: number; dropped: number } {
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

  peek(recipient: string): { count: number } {
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

  poll(recipient: string, maxItems: number): unknown[] {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return [];
    }
    const now = this.now();
    this.purgeExpired(mailbox, now);

    const count = Math.min(maxItems, mailbox.queue.length);
    const items: unknown[] = [];
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

  private purgeExpired(mailbox: RecipientMailbox, now: number): void {
    while (mailbox.queue.length > 0) {
      const entry = mailbox.queue[0];
      if (now - entry.enqueuedAt < this.ttlMs) {
        break;
      }
      mailbox.queue.shift();
    }
  }

  private ensureRecipientLimit(): void {
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

  private logDropOldest(recipient: string, dropped: number, queueDepth: number): void {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}
