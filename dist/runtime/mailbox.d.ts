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
export type SQLiteMailboxStoreOptions = MailboxOptions & {
    sqlitePath?: string;
};
export type RedisMailboxStoreOptions = MailboxOptions & {
    redisUrl?: string;
    redisHost?: string;
    redisPort?: number;
    redisDb?: number;
    redisUsername?: string;
    redisPassword?: string;
    redisKeyPrefix?: string;
    redisCliPath?: string;
    redisCommandTimeoutMs?: number;
};
export type MailboxStoreType = "memory" | "sqlite" | "redis";
export type MailboxStoreEnqueueResult = {
    queueDepth: number;
    dropped: number;
};
export type MailboxStorePeekResult = {
    count: number;
};
export interface MailboxStore {
    enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult;
    peek(recipient: string): MailboxStorePeekResult;
    poll(recipient: string, maxItems: number): unknown[];
    cleanupExpired?(): number;
    close?(): void;
}
export declare const SQLITE_MAILBOX_SCHEMA = "\nCREATE TABLE IF NOT EXISTS mailbox_recipients (\n  recipient TEXT PRIMARY KEY,\n  last_activity INTEGER NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS mailbox_messages (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  recipient TEXT NOT NULL,\n  envelope_json TEXT NOT NULL,\n  enqueued_at INTEGER NOT NULL,\n  FOREIGN KEY(recipient) REFERENCES mailbox_recipients(recipient) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_mailbox_messages_recipient_id\n  ON mailbox_messages(recipient, id);\n\nCREATE INDEX IF NOT EXISTS idx_mailbox_messages_enqueued_at\n  ON mailbox_messages(enqueued_at);\n";
export declare class InMemoryMailboxStore implements MailboxStore {
    private ttlMs;
    private maxQueueLength;
    private maxRecipients;
    private now;
    private logger;
    private mailboxes;
    constructor(options?: MailboxOptions);
    enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult;
    peek(recipient: string): MailboxStorePeekResult;
    poll(recipient: string, maxItems: number): unknown[];
    cleanupExpired(): number;
    private purgeExpired;
    private ensureRecipientLimit;
    private logDropOldest;
}
export declare class Mailbox extends InMemoryMailboxStore {
    constructor(options?: MailboxOptions);
}
export declare class SQLiteMailboxStore implements MailboxStore {
    private ttlMs;
    private maxQueueLength;
    private maxRecipients;
    private now;
    private logger;
    private db;
    private selectRecipientCountStatement;
    private selectMessageCountByRecipientStatement;
    private insertRecipientStatement;
    private insertMessageStatement;
    private deleteOldestByRecipientStatement;
    private deleteEmptyRecipientsStatement;
    private selectOldestRecipientsStatement;
    private deleteMessagesForRecipientStatement;
    private deleteRecipientStatement;
    private updateRecipientActivityStatement;
    private selectPollItemsStatement;
    private deleteExpiredMessagesStatement;
    constructor(options?: SQLiteMailboxStoreOptions);
    enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult;
    peek(recipient: string): MailboxStorePeekResult;
    poll(recipient: string, maxItems: number): unknown[];
    cleanupExpired(): number;
    close(): void;
    private purgeExpiredInternal;
    private ensureRecipientLimitInternal;
    private selectCountForRecipient;
    private deleteMessageIds;
    private withTransaction;
    private logDropOldest;
}
export declare class RedisMailboxStore implements MailboxStore {
    private ttlMs;
    private maxQueueLength;
    private maxRecipients;
    private now;
    private logger;
    private redisCliPath;
    private redisUrl;
    private redisHost;
    private redisPort;
    private redisDb;
    private redisUsername;
    private redisPassword;
    private redisKeyPrefix;
    private redisCommandTimeoutMs;
    constructor(options?: RedisMailboxStoreOptions);
    enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult;
    peek(recipient: string): MailboxStorePeekResult;
    poll(recipient: string, maxItems: number): unknown[];
    cleanupExpired(): number;
    private ttlSeconds;
    private queueKey;
    private recipientsKey;
    private touchRecipient;
    private removeRecipient;
    private enforceRecipientLimit;
    private purgeExpiredForRecipient;
    private readInteger;
    private readList;
    private runRedis;
    private logDropOldest;
}
export type CreateMailboxStoreOptions = MailboxOptions & {
    type?: MailboxStoreType;
    sqlitePath?: string;
    redisUrl?: string;
    redisHost?: string;
    redisPort?: number;
    redisDb?: number;
    redisUsername?: string;
    redisPassword?: string;
    redisKeyPrefix?: string;
    redisCliPath?: string;
    redisCommandTimeoutMs?: number;
};
export declare function createMailboxStore(options?: CreateMailboxStoreOptions): MailboxStore;
export declare function parseMailboxStoreType(value: string | undefined): MailboxStoreType;
