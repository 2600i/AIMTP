"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRouter = exports.RouteError = void 0;
class RouteError extends Error {
    constructor(missingRecipients) {
        super(`Unknown recipient(s): ${missingRecipients.join(", ")}`);
        this.missingRecipients = missingRecipients;
    }
}
exports.RouteError = RouteError;
class MessageRouter {
    constructor(registry) {
        this.registry = registry;
    }
    async deliver(route) {
        if (!route.recipients || route.recipients.length === 0) {
            throw new Error("At least one recipient is required");
        }
        const missing = [];
        for (const recipient of route.recipients) {
            if (!this.registry.get(recipient)) {
                missing.push(recipient);
            }
        }
        if (missing.length > 0) {
            throw new RouteError(missing);
        }
        for (const recipient of route.recipients) {
            const target = this.registry.get(recipient);
            if (!target) {
                continue;
            }
            await target.handler(route.message, {
                sender: route.sender,
                task: route.task,
                metadata: route.metadata
            });
        }
    }
}
exports.MessageRouter = MessageRouter;
