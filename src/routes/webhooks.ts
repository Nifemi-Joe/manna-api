/**
 * src/routes/webhooks.ts
 * POST /api/v1/webhooks/resend
 *
 * Receives Resend webhook events — most relevantly `email.received` for
 * inbound email (replies, support requests, etc.), plus delivery-status
 * events (sent/delivered/bounced/complained) for observability.
 *
 * Setup required in the Resend dashboard:
 *   1. Verify a domain with inbound routing enabled.
 *   2. Webhooks → Add Endpoint → point at:
 *        https://<your-api-domain>/api/v1/webhooks/resend
 *      Subscribe to the events you care about (at minimum `email.received`).
 *   3. Copy the generated "Signing Secret" into RESEND_WEBHOOK_SECRET in .env.
 *
 * Resend signs webhook payloads using Svix-style headers:
 *   webhook-id, webhook-timestamp, webhook-signature
 * We verify these via the Resend SDK's `webhooks.verify()` before trusting
 * any payload — never process an unverified webhook body.
 */

import type { FastifyPluginAsync } from 'fastify';
import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

// A Resend client instance is required to call webhooks.verify(), even
// though we're not sending mail from this route.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const webhookRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /api/v1/webhooks/resend
  // IMPORTANT: this route needs the raw request body (string) for signature
  // verification, not Fastify's auto-parsed JSON — see addContentTypeParser
  // registered below, scoped to this plugin only.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  fastify.post('/resend', async (req, reply) => {
    if (!resend || !RESEND_WEBHOOK_SECRET) {
      fastify.log.warn('Resend webhook received but RESEND_API_KEY/RESEND_WEBHOOK_SECRET not configured');
      return reply.status(503).send({ message: 'Webhook receiver not configured' });
    }

    const rawBody = req.body as unknown as string;

    const webhookId = req.headers['webhook-id'] as string | undefined;
    const webhookTimestamp = req.headers['webhook-timestamp'] as string | undefined;
    const webhookSignature = req.headers['webhook-signature'] as string | undefined;

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      return reply.status(400).send({ message: 'Missing webhook signature headers' });
    }

    let event;
    try {
      event = resend.webhooks.verify({
        payload: rawBody,
        headers: {
          id: webhookId,
          timestamp: webhookTimestamp,
          signature: webhookSignature,
        },
        webhookSecret: RESEND_WEBHOOK_SECRET,
      });
    } catch (err) {
      fastify.log.warn({ err }, 'Resend webhook signature verification failed');
      return reply.status(401).send({ message: 'Invalid webhook signature' });
    }

    switch (event.type) {
      case 'email.received': {
        const { from, to, subject, message_id, attachments } = event.data;
        fastify.log.info(
          { from, to, subject, messageId: message_id, attachmentCount: attachments?.length ?? 0 },
          'Inbound email received via Resend'
        );

        // TODO: hook up your actual inbound-email business logic here, e.g.:
        //   - create a support ticket / issue from the email body
        //   - match `from` against a known user and append to a thread
        //   - store the raw payload for later review
        //
        // The full parsed body/attachments aren't included in the webhook
        // payload itself — use resend.emails.receiving.get(event.data.email_id)
        // to fetch the full inbound email content if you need the body text.
        break;
      }

      case 'email.delivered':
      case 'email.bounced':
      case 'email.complained':
      case 'email.opened':
      case 'email.clicked':
      case 'email.failed': {
        fastify.log.info({ type: event.type, data: event.data }, 'Resend delivery event');
        break;
      }

      default: {
        fastify.log.info({ type: event.type }, 'Unhandled Resend webhook event type');
      }
    }

    return reply.status(200).send({ received: true });
  });
};

export default webhookRoutes;