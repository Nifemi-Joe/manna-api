/**
 * src/services/sms.ts
 * Sends SMS via Termii (https://termii.com) — a Nigerian SMS/OTP provider.
 *
 * DEV LOGGING: same fix as email.ts — every SMS this module sends now
 * always prints to console when NODE_ENV !== 'production', regardless
 * of whether TERMII_API_KEY is configured, so an OTP code sent via SMS
 * is never invisible while you're developing without a real provider.
 */

const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID ?? 'Manna';
const TERMII_BASE_URL = 'https://api.ng.termii.com/api/sms/send';
const isDev = process.env.NODE_ENV !== 'production';

export interface SmsResult {
  sent: boolean;
  error?: string;
}

function normalizeNigerianPhone(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('234') && digits.length === 13) return digits;
  if (digits.startsWith('0') && digits.length === 11) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return null;
}

function logToConsole(to: string, message: string) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📱  SMS (dev console log — see services/sms.ts)');
  console.log(`    To:      ${to}`);
  console.log(`    Message: ${message}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

export async function sendSms(phone: string, message: string): Promise<SmsResult> {
  const to = normalizeNigerianPhone(phone);
  if (!to) {
    if (isDev) console.log(`📱 SMS not sent — could not normalize phone number: ${phone}`);
    return { sent: false, error: `Could not normalize phone number: ${phone}` };
  }

  if (isDev) logToConsole(to, message);

  if (!TERMII_API_KEY) {
    return { sent: false, error: 'TERMII_API_KEY not configured — printed to console instead' };
  }

  try {
    const res = await fetch(TERMII_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from: TERMII_SENDER_ID,
        sms: message,
        type: 'plain',
        channel: 'generic',
        api_key: TERMII_API_KEY,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const error = (data as any)?.message ?? `HTTP ${res.status}`;
      console.error(`Termii send failed: ${error}`);
      return { sent: false, error };
    }

    if (isDev) console.log(`📱 Also sent for real via Termii to ${to}`);
    return { sent: true };
  } catch (err: any) {
    console.error('Termii request failed:', err?.message ?? err);
    return { sent: false, error: err?.message ?? 'Unknown SMS send error' };
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<SmsResult> {
  return sendSms(phone, `${code} is your Manna sign-in code. It expires in 10 minutes.`);
}