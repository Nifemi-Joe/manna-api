/**
 * ADD THESE THREE FUNCTIONS to your existing src/services/email.ts —
 * this is NOT a full file, it's an addition. They follow the exact same
 * conventions already in that file (emailShell, button, trySend), so
 * paste them in alongside sendMagicLink / sendOtpEmail / etc, and add
 * their names to that file's exports at the bottom if it has an
 * explicit export list.
 *
 * These get called by routes/admin-orders.ts and routes/orders-swap.ts
 * via the notifyUsers({ ..., emailFn }) pattern in
 * services/notifications.ts — that's what actually triggers the send,
 * gated by the recipient's own email preference for that kind.
 */

