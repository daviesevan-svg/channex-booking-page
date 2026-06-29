// Client-safe webhook event names + type (no server-only deps), so the admin
// UI can import them without pulling in webhooks.server.
export const WEBHOOK_EVENTS = ["booking.created", "booking.cancelled"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
