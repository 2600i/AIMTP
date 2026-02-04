export type MailboxLogger = {
    log: (message: string) => void;
} | null;
export type MailboxOptions = {
    ttlMs?: number;
    maxQueueLength?: number;
    maxRecipients?: number;
    now?: () => number;
    logger?: MailboxLogger;
};
export declare class Mailbox {
    private ttlMs;
    private maxQueueLength;
    private maxRecipients;
    private now;
    private logger;
    private mailboxes;
    constructor(options?: MailboxOptions);
    enqueue(recipient: string, envelope: unknown): {
        queueDepth: number;
        dropped: number;
    };
    peek(recipient: string): {
        count: number;
    };
    poll(recipient: string, maxItems: number): unknown[];
    private purgeExpired;
    private ensureRecipientLimit;
    private logDropOldest;
}
