/**
 * src/services/email.ts
 * Sends transactional email via Resend (https://resend.com).
 * Falls back to console logging in local dev when no API key is set,
 * so local dev never accidentally sends real email.
 */

import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const isDev = process.env.NODE_ENV !== 'production';

// Only construct the client if we actually have a key — avoids throwing
// at import time in environments (like local dev) that don't set one.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const FROM = process.env.EMAIL_FROM ?? 'Manna Office Meals <noreply@mannaworkmeals.com>';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const MAGIC_LINK_EXPIRY_MINUTES = process.env.MAGIC_LINK_EXPIRY_MINUTES ?? '15';

function magicLinkHtml(link: string): string {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;color:#101828;">
  <div style="margin-bottom:24px;">
    <span style="font-size:22px;font-weight:700;color:#1A7A4A;">Manna</span>
  </div>
  <h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">Your sign-in link</h1>
  <p style="color:#475467;margin-bottom:24px;">
    Click the button below to sign in to Manna Office Meals.
    This link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.
  </p>
  <a href="${link}"
     style="display:inline-block;background:#1765D8;color:#fff;text-decoration:none;
            padding:12px 24px;border-radius:10px;font-weight:600;font-size:15px;">
    Sign in to Manna
  </a>
  <p style="margin-top:24px;font-size:13px;color:#667085;">
    If you didn't request this, you can safely ignore this email.<br/>
    This link can only be used once.
  </p>
  <hr style="border:none;border-top:1px solid #D0D9E4;margin-top:32px;"/>
  <p style="font-size:12px;color:#98A2B3;">Manna Work Meals Ltd, Lagos, Nigeria</p>
</body>
</html>`;
}

export interface MagicLinkResult {
    /** The full sign-in URL — always populated, regardless of send outcome. */
    link: string;
    /** True if Resend confirmed the email was accepted for delivery. */
    sent: boolean;
    /** Populated only when `sent` is false — the reason the send failed. */
    error?: string;
}

/**
 * Sends a magic sign-in link to the given email via Resend.
 *
 * Unlike a typical "send" function, this NEVER throws on a delivery
 * failure — it always returns the generated link plus a `sent` flag and
 * optional `error`. This lets the caller (routes/auth.ts) decide whether
 * to expose the link directly as a fallback when delivery isn't possible
 * (e.g. an unverified sending domain), instead of the request failing
 * with a 500 and leaving the user with no way to sign in at all.
 */
export async function sendMagicLink(email: string, token: string): Promise<MagicLinkResult> {
    const link = `${APP_URL}/login?token=${encodeURIComponent(token)}`;

    if (!resend) {
        // No RESEND_API_KEY configured at all — log-only, same as before.
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📧  MAGIC LINK (RESEND_API_KEY not set)');
        console.log(`    To: ${email}`);
        console.log(`    Link: ${link}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return { link, sent: false, error: 'RESEND_API_KEY not configured' };
    }

    const { data, error } = await resend.emails.send({
        from: FROM,
        to: email,
        subject: 'Your Manna sign-in link',
        html: magicLinkHtml(link),
        text: `Sign in to Manna: ${link}\n\nThis link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.`,
    });

    if (error) {
        // Don't throw — surface the failure to the caller instead, so a
        // misconfigured domain doesn't turn into a hard 500 for the user.
        console.error(`Resend send failed: ${error.name} — ${error.message}`);
        return { link, sent: false, error: `${error.name}: ${error.message}` };
    }

    if (isDev) {
        console.log(`📧 Magic link email sent via Resend (id: ${data?.id}) to ${email}`);
    }

    return { link, sent: true };
}

/**
 * Generic transactional sender for any future email (welcome, receipts, etc).
 * Kept separate from sendMagicLink so callers don't need the magic-link HTML.
 */
export async function sendEmail(opts: {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
}): Promise<{ id: string } | { skipped: true }> {
    if (!resend) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📧  EMAIL (dev mode — RESEND_API_KEY not set)');
        console.log(`    To: ${Array.isArray(opts.to) ? opts.to.join(', ') : opts.to}`);
        console.log(`    Subject: ${opts.subject}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return { skipped: true };
    }

    const { data, error } = await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text ?? '',
        replyTo: opts.replyTo,
    });

    if (error) {
        throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
    }

    return { id: data!.id };
}

export { resend };