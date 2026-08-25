/**
 * scripts/verify-email-delivery.ts
 *
 * Run this ONCE against your production environment before letting any
 * real customer touch the app. Sends a real email through Resend and
 * tells you exactly what to check — this is not a smoke test that just
 * checks for a thrown error, since Resend can return sent:true while
 * the message still gets caught by spam filtering or bounces silently
 * on the receiving end.
 *
 * Usage: RESEND_API_KEY=re_xxx EMAIL_FROM="..." tsx scripts/verify-email-delivery.ts you@yourrealinbox.com
 */
import 'dotenv/config';
import { Resend } from 'resend';

const to = "nifemi1big@gmail.com";
if (!to) {
    console.error('Usage: tsx scripts/verify-email-delivery.ts you@yourrealinbox.com');
    process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM;

if (!apiKey) { console.error('RESEND_API_KEY not set'); process.exit(1); }
if (!from) { console.error('EMAIL_FROM not set'); process.exit(1); }

const resend = new Resend(apiKey);

async function main() {
    console.log(`Sending test email from ${from} to ${to}...`);

    const { data, error } = await resend.emails.send({
        from,
        to,
        subject: 'Manna — production email delivery test',
        html: `<p>If you're reading this in your inbox (not spam), your production email setup is working.</p>
               <p>Sent at: ${new Date().toISOString()}</p>`,
        text: `If you're reading this, production email setup is working. Sent at: ${new Date().toISOString()}`,
    });

    if (error) {
        console.error('❌ Resend rejected the send:', error.name, '—', error.message);
        console.error('   Common causes: domain not verified yet, EMAIL_FROM doesn\'t match a verified domain, or the API key is wrong/restricted.');
        process.exit(1);
    }

    console.log(`✓ Resend accepted the send. Message ID: ${data?.id}`);
    console.log('\nNOW GO CHECK, IN THIS ORDER:');
    console.log('  1. Your actual inbox — did it arrive within ~30 seconds?');
    console.log('  2. Your spam/junk folder — if it landed there, SPF/DKIM likely isn\'t fully propagated yet.');
    console.log(`  3. Resend dashboard → Emails → look up message ID ${data?.id} — check its status (delivered/bounced/complained).`);
    console.log('  4. Open the email and view its original/raw headers (Gmail: ⋮ → "Show original") — look for');
    console.log('     "SPF: PASS" and "DKIM: PASS". If either says FAIL or NEUTRAL, your DNS records aren\'t right yet.');
    console.log('  5. For a full deliverability score, forward the message to a fresh address at mail-tester.com');
    console.log('     and check the score it gives you — aim for 9-10/10 before going live.');
}

main();