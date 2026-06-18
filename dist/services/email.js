/**
 * src/services/email.ts
 * Sends magic link emails via SMTP (Nodemailer).
 * Falls back to console log in development.
 */
import nodemailer from 'nodemailer';
const isDev = process.env.NODE_ENV !== 'production';
function createTransport() {
    if (isDev) {
        // Log-only transport for development
        return nodemailer.createTransport({
            streamTransport: true,
            newline: 'unix',
            buffer: true,
        });
    }
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST ?? 'localhost',
        port: parseInt(process.env.SMTP_PORT ?? '587', 10),
        secure: parseInt(process.env.SMTP_PORT ?? '587', 10) === 465,
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
    });
}
const transport = createTransport();
const FROM = process.env.EMAIL_FROM ?? 'noreply@mannaworkmeals.com';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
export async function sendMagicLink(email, token) {
    const link = `${APP_URL}/login?token=${encodeURIComponent(token)}`;
    const html = `
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
    This link expires in ${process.env.MAGIC_LINK_EXPIRY_MINUTES ?? 15} minutes.
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
    if (isDev) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📧  MAGIC LINK (dev mode)');
        console.log(`    To: ${email}`);
        console.log(`    Link: ${link}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return link;
    }
    await transport.sendMail({
        from: `Manna Office Meals <${FROM}>`,
        to: email,
        subject: 'Your Manna sign-in link',
        html,
        text: `Sign in to Manna: ${link}\n\nThis link expires in ${process.env.MAGIC_LINK_EXPIRY_MINUTES ?? 15} minutes.`,
    });
    return link;
}
