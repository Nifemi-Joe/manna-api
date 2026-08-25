/**
 * src/services/email.ts
 * Sends transactional email via Resend (https://resend.com).
 *
 * REDESIGNED (this pass): every template now shares one branded
 * `emailShell()` — table-based HTML (not flexbox/grid, which Outlook's
 * Word rendering engine still doesn't support), matching the app's
 * actual brand tokens: brand green header, amber CTA buttons, bold
 * sans headings, a proper footer with your business address and a
 * notification-preferences link. Previously every email used a bare,
 * unbranded shell with a blue button that didn't match anything.
 *
 * DEV LOGGING: unchanged from before — every send still prints to
 * console when NODE_ENV !== 'production', regardless of whether
 * RESEND_API_KEY is configured, so nothing here is invisible while
 * you're developing.
 */
import { Resend } from 'resend';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const isDev = process.env.NODE_ENV !== 'production';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM ?? 'Manna Office Meals <noreply@mannaworkmeals.com>';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const MAGIC_LINK_EXPIRY_MINUTES = process.env.MAGIC_LINK_EXPIRY_MINUTES ?? '15';
const OTP_EXPIRY_MINUTES = process.env.OTP_EXPIRY_MINUTES ?? '10';
const SALES_INBOX = process.env.SALES_NOTIFICATION_EMAIL ?? 'hello@mannaworkmeals.com';
// ── Brand tokens — kept in sync with globals.css by hand, since email
// clients can't read CSS custom properties. If the app's palette ever
// changes again, these six lines are what to update here too. ──────────
const BRAND = {
    green: '#2E9E52',
    greenDark: '#1F6B3B',
    greenTint: '#E9F6ED',
    amber: '#D98A2B',
    amberDark: '#C07A22',
    coral: '#D9542B',
    ink: '#16211B',
    muted: '#64716A',
    line: '#E4E7DE',
    surfaceSoft: '#F6F7F4',
};
const FONT_STACK = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
// ═══════════════════════════════════════════════════════════════════
// Shared building blocks — table-based so Outlook renders them correctly
// ═══════════════════════════════════════════════════════════════════
/**
 * The branded wrapper every email is built inside. Structure:
 *   outer table (full-width, soft background) →
 *     centered 560px card (white, rounded, subtle border) →
 *       green header band with the Manna wordmark →
 *       content area (bodyHtml goes here) →
 *       footer (address, preferences link, copyright)
 */
function emailShell(bodyHtml, opts) {
    const preheader = opts?.preheader ?? '';
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>Manna Office Meals</title>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.surfaceSoft}; font-family:${FONT_STACK};">
  ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.surfaceSoft}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px; max-width:100%; background-color:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid ${BRAND.line};">

          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND.greenDark}; padding:28px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:22px; line-height:1; padding-right:8px;">🍲</td>
                  <td style="font-family:${FONT_STACK}; font-size:20px; font-weight:800; color:#FFFFFF; letter-spacing:-0.02em;">Manna</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:36px 32px 32px 32px; font-family:${FONT_STACK}; color:${BRAND.ink};">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px 28px 32px; border-top:1px solid ${BRAND.line}; background-color:${BRAND.surfaceSoft};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${FONT_STACK}; font-size:12px; color:${BRAND.muted}; line-height:1.6;">
                    <strong style="color:${BRAND.ink};">Manna Office Meals</strong><br/>
                    Manna Work Meals Ltd &middot; Lagos, Nigeria<br/>
                    <a href="${APP_URL}" style="color:${BRAND.green}; text-decoration:none;">Sign in</a>
                    &nbsp;&middot;&nbsp;
                    <a href="${APP_URL}" style="color:${BRAND.green}; text-decoration:none;">Manage notification preferences</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}
/** Primary call-to-action button — amber, matches the app's amber CTA color. */
function button(label, href, variant = 'amber') {
    const bg = variant === 'amber' ? BRAND.amber : variant === 'coral' ? BRAND.coral : BRAND.green;
    return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 4px 0;">
      <tr>
        <td style="border-radius:10px; background-color:${bg};">
          <a href="${href}" target="_blank"
             style="display:inline-block; padding:13px 28px; font-family:${FONT_STACK}; font-size:15px; font-weight:700; color:#FFFFFF; text-decoration:none; border-radius:10px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}
/** Small colored status/category pill — used for lead status, order kind, etc. */
function badge(label, tone = 'green') {
    const colors = {
        green: { bg: BRAND.greenTint, fg: BRAND.greenDark },
        amber: { bg: '#FBEEDA', fg: BRAND.amberDark },
        coral: { bg: '#FCE6DD', fg: BRAND.coral },
    }[tone];
    return `<span style="display:inline-block; padding:4px 10px; border-radius:999px; background-color:${colors.bg}; color:${colors.fg}; font-family:${FONT_STACK}; font-size:11px; font-weight:700; letter-spacing:0.02em; text-transform:uppercase;">${label}</span>`;
}
/** A clean label/value row inside a light info card — for lead details, order summaries, etc. */
function infoRow(label, value) {
    return `
    <tr>
      <td style="padding:7px 0; font-family:${FONT_STACK}; font-size:13px; color:${BRAND.muted}; width:40%;">${label}</td>
      <td style="padding:7px 0; font-family:${FONT_STACK}; font-size:13px; color:${BRAND.ink}; font-weight:600; text-align:right;">${value}</td>
    </tr>`;
}
/** Wraps a set of infoRow()s in the light card look used throughout. */
function infoCard(rows) {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.surfaceSoft}; border-radius:12px; padding:4px 16px; margin:20px 0;">
      ${rows}
    </table>`;
}
function heading(text) {
    return `<h1 style="font-family:${FONT_STACK}; font-size:22px; font-weight:800; color:${BRAND.ink}; margin:0 0 10px 0; letter-spacing:-0.01em;">${text}</h1>`;
}
function paragraph(text) {
    return `<p style="font-family:${FONT_STACK}; font-size:15px; line-height:1.6; color:${BRAND.muted}; margin:0 0 20px 0;">${text}</p>`;
}
function fineprint(text) {
    return `<p style="font-family:${FONT_STACK}; font-size:12px; line-height:1.6; color:${BRAND.muted}; margin:20px 0 0 0;">${text}</p>`;
}
function formatNairaForEmail(n) {
    return `₦${n.toLocaleString('en-NG')}`;
}
function logToConsole(opts) {
    const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧  EMAIL (dev console log — see services/email.ts)');
    console.log(`    To:      ${to}`);
    console.log(`    Subject: ${opts.subject}`);
    console.log(`    ${opts.text.split('\n').join('\n    ')}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}
async function trySend(opts) {
    if (isDev)
        logToConsole(opts);
    if (!resend) {
        return { sent: false, error: 'RESEND_API_KEY not configured — printed to console instead' };
    }
    const { data, error } = await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
    });
    if (error) {
        console.error(`Resend send failed: ${error.name} — ${error.message}`);
        return { sent: false, error: `${error.name}: ${error.message}` };
    }
    if (isDev)
        console.log(`📧 Also sent for real via Resend (id: ${data?.id})`);
    return { sent: true };
}
export async function sendMagicLink(email, token) {
    const link = `${APP_URL}/login?token=${encodeURIComponent(token)}`;
    const html = emailShell(`
        ${heading('Your sign-in link')}
        ${paragraph(`Click the button below to sign in to Manna Office Meals. This link expires in <strong style="color:${BRAND.ink};">${MAGIC_LINK_EXPIRY_MINUTES} minutes</strong> and can only be used once.`)}
        ${button('Sign in to Manna', link)}
        ${fineprint("If you didn't request this, you can safely ignore this email — no account changes will be made.")}
    `, { preheader: 'Your secure sign-in link for Manna Office Meals' });
    const result = await trySend({
        to: email,
        subject: 'Your Manna sign-in link',
        html,
        text: `LINK: ${link}\n(expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes)`,
    });
    return { link, ...result };
}
// ═══════════════════════════════════════════════════════════════════
// 2. OTP code
// ═══════════════════════════════════════════════════════════════════
export async function sendOtpEmail(email, code) {
    const codeDisplay = `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
          <tr>
            <td style="background-color:${BRAND.greenTint}; border-radius:12px; padding:18px 28px;">
              <span style="font-family:${FONT_STACK}; font-size:34px; font-weight:800; letter-spacing:0.18em; color:${BRAND.greenDark};">${code}</span>
            </td>
          </tr>
        </table>`;
    const html = emailShell(`
        ${heading('Your sign-in code')}
        ${paragraph(`Enter this code to sign in to Manna. It expires in <strong style="color:${BRAND.ink};">${OTP_EXPIRY_MINUTES} minutes</strong>.`)}
        ${codeDisplay}
        ${fineprint("If you didn't request this, you can safely ignore this email.")}
    `, { preheader: `${code} is your Manna sign-in code` });
    return trySend({
        to: email,
        subject: `${code} is your Manna sign-in code`,
        html,
        text: `CODE: ${code}\n(expires in ${OTP_EXPIRY_MINUTES} minutes)`,
    });
}
export async function sendPilotRequestNotification(lead) {
    const adminUrl = `${APP_URL.replace(/\/$/, '')}/admin/leads`;
    const rows = [
        infoRow('Company', lead.companyName),
        infoRow('Contact', lead.contactName),
        infoRow('Email', lead.email),
        lead.phone ? infoRow('Phone', lead.phone) : '',
        infoRow('Team size', lead.teamSize),
    ].join('');
    const html = emailShell(`
        ${badge('New pilot request', 'amber')}
        <div style="height:12px;"></div>
        ${heading('A new company wants a pilot')}
        ${paragraph('Review the details below and follow up — most leads convert best when contacted within the first business day.')}
        ${infoCard(rows)}
        ${button('Review in Admin', adminUrl)}
    `, { preheader: `New pilot request from ${lead.companyName}` });
    return trySend({
        to: SALES_INBOX,
        subject: `New pilot request — ${lead.companyName}`,
        html,
        text: `LEAD ID: ${lead.id}\nCompany: ${lead.companyName}\nContact: ${lead.contactName} <${lead.email}>${lead.phone ? `\nPhone: ${lead.phone}` : ''}\nTeam size: ${lead.teamSize}\nReview: ${adminUrl}`,
    });
}
export async function sendOnboardingEmail(info) {
    const loginUrl = `${APP_URL.replace(/\/$/, '')}/login?redirect=/hr/dashboard`;
    const html = emailShell(`
        ${badge('Welcome to Manna', 'green')}
        <div style="height:12px;"></div>
        ${heading(`${info.companyName} is ready`)}
        ${paragraph(`Hi ${info.hrName}, your company's Manna pilot is set up. Sign in with your work email below — no password to remember, we'll send a secure link or a one-time code each time.`)}
        ${button('Sign in to your HR dashboard', loginUrl)}
        <div style="height:8px;"></div>
        <p style="font-family:${FONT_STACK}; font-size:14px; color:${BRAND.ink}; font-weight:700; margin:28px 0 10px 0;">Once you're in, you can:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;">
          <tr><td style="padding:4px 0; font-family:${FONT_STACK}; font-size:14px; color:${BRAND.muted};">🍽️&nbsp;&nbsp;Upload your team via CSV or Excel with individual allowances</td></tr>
          <tr><td style="padding:4px 0; font-family:${FONT_STACK}; font-size:14px; color:${BRAND.muted};">📅&nbsp;&nbsp;Choose which days and meal windows your plan covers</td></tr>
          <tr><td style="padding:4px 0; font-family:${FONT_STACK}; font-size:14px; color:${BRAND.muted};">📊&nbsp;&nbsp;Track orders, spend, and delivery in real time</td></tr>
        </table>
        ${fineprint(`Sign-in email: <strong style="color:${BRAND.ink};">${info.hrEmail}</strong>`)}
    `, { preheader: `${info.companyName} is ready on Manna` });
    return trySend({
        to: info.hrEmail,
        subject: `Welcome to Manna — ${info.companyName} is ready`,
        html,
        text: `Company: ${info.companyName}\nHR contact: ${info.hrName} <${info.hrEmail}>\nLOGIN LINK: ${loginUrl}`,
    });
}
export async function sendDailyMenuEmail(to, info) {
    const orderUrl = `${APP_URL.replace(/\/$/, '')}/employee/menu`;
    const windowLabel = info.mealWindow === 'breakfast' ? 'Breakfast' : 'Lunch';
    const mealRows = info.meals
        .map((m) => `
        <tr>
          <td style="padding:9px 0; border-bottom:1px solid ${BRAND.line}; font-family:${FONT_STACK}; font-size:14px; color:${BRAND.ink};">${m.name}</td>
          <td style="padding:9px 0; border-bottom:1px solid ${BRAND.line}; font-family:${FONT_STACK}; font-size:14px; color:${BRAND.muted}; text-align:right;">${formatNairaForEmail(m.price)}</td>
        </tr>`)
        .join('');
    const html = emailShell(`
        ${badge(`Today's ${windowLabel.toLowerCase()}`, 'green')}
        <div style="height:12px;"></div>
        ${heading(`${windowLabel} is ready to order`)}
        ${paragraph(`Hi ${info.employeeName}, you have <strong style="color:${BRAND.greenDark};">${formatNairaForEmail(info.allowanceRemaining)}</strong> available for ${windowLabel.toLowerCase()} today. Order before <strong style="color:${BRAND.ink};">${info.cutoffTime}</strong>.`)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 24px 0;">
          ${mealRows}
        </table>
        ${button(`Order ${windowLabel.toLowerCase()}`, orderUrl)}
        ${fineprint('Meal costs more than your allowance? You can pay the difference with your own card at checkout.')}
    `, { preheader: `${windowLabel} is ready — order before ${info.cutoffTime}` });
    return trySend({
        to,
        subject: `${windowLabel} is ready to order — cutoff ${info.cutoffTime}`,
        html,
        text: `${windowLabel}: ${info.meals.map((m) => `${m.name} (${formatNairaForEmail(m.price)})`).join(', ')}\nAllowance remaining: ${formatNairaForEmail(info.allowanceRemaining)}\nCutoff: ${info.cutoffTime}\nORDER LINK: ${orderUrl}`,
    });
}
export async function sendOrderCancelledEmail(to, recipientName, info) {
    const html = emailShell(`
    <h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">Your order was cancelled</h1>
    <p style="color:#475467;margin-bottom:16px;">
      Hi ${recipientName}, your order for <strong>${info.mealName}</strong> on ${info.date} has been cancelled.
    </p>
    <p style="font-size:13px;color:#667085;">
      If your company covers this via an allowance, it's already been credited back automatically.
      If you have questions, reach out to your HR team.
    </p>
  `);
    return trySend({
        to,
        subject: `Your order was cancelled — ${info.mealName}`,
        html,
        text: `Your order for ${info.mealName} on ${info.date} has been cancelled.`,
    });
}
// ═══════════════════════════════════════════════════════════════════
// 7. Order delivered
// ═══════════════════════════════════════════════════════════════════
export async function sendOrderDeliveredEmail(to, recipientName, info) {
    const html = emailShell(`
    <h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">Your order has arrived</h1>
    <p style="color:#475467;margin-bottom:16px;">
      Hi ${recipientName}, your order for <strong>${info.mealName}</strong> has been delivered. Enjoy!
    </p>
  `);
    return trySend({
        to,
        subject: `Delivered — ${info.mealName}`,
        html,
        text: `Your order for ${info.mealName} has been delivered.`,
    });
}
export async function sendSwapNeededEmail(to, recipientName, info) {
    const altRows = info.alternatives
        .map((a) => `<tr><td style="padding:6px 0;color:#101828;">${a.name}</td><td style="padding:6px 0;text-align:right;color:#475467;">₦${a.price.toLocaleString('en-NG')}</td></tr>`)
        .join('');
    const html = emailShell(`
    <h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">We're out of ${info.mealName}</h1>
    <p style="color:#475467;margin-bottom:16px;">
      Hi ${recipientName}, unfortunately <strong>${info.mealName}</strong> for ${info.date} is no longer available.
      Here's what you can swap it for instead — or cancel if none of these work.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0 20px;">${altRows}</table>
    ${button('Choose an alternative', info.orderUrl)}
    <p style="margin-top:16px;font-size:13px;color:#667085;">
      If you don't choose in time, your order will need to be cancelled manually — please act before the cutoff.
    </p>
  `);
    return trySend({
        to,
        subject: `Action needed — ${info.mealName} is unavailable`,
        html,
        text: `${info.mealName} is unavailable for ${info.date}. Alternatives: ${info.alternatives.map((a) => `${a.name} (₦${a.price})`).join(', ')}. Choose here: ${info.orderUrl}`,
    });
}
/** Generic transactional sender for anything not covered above. */
export async function sendEmail(opts) {
    if (isDev)
        logToConsole({ to: opts.to, subject: opts.subject, text: opts.text ?? '(no plain-text body provided)' });
    if (!resend)
        return { skipped: true };
    const { data, error } = await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text ?? '',
        replyTo: opts.replyTo,
    });
    if (error)
        throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
    return { id: data.id };
}
export { resend };
