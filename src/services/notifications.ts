/**
 * src/services/notifications.ts
 * Creates in-app notifications AND, for kinds that warrant it, sends
 * email — both gated by each recipient's own preferences.
 *
 * UPDATED (this pass): preference-aware. Before, notifyUsers always
 * created an in-app row and never sent email at all. Now:
 *   - Checks notification_preferences per (user, kind) before creating
 *     the in-app row at all — if someone's turned a kind off, nothing
 *     gets created, not just hidden.
 *   - Optionally sends email too, via `emailFn`, gated by the same
 *     user's email_enabled preference for that kind.
 * Opt-OUT model: no preference row for a (user, kind) pair means both
 * channels are enabled by default.
 */

import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

export type NotificationKind = 'lead' | 'issue' | 'order' | 'order_cancelled' | 'order_delivered' | 'order_swap_needed' | 'system';

export interface NotifyInput {
    kind: NotificationKind;
    title: string;
    body: string;
    link?: string;
    /** If provided, called once per recipient whose email preference for
        this kind is enabled — should perform the actual send (e.g. a
        function from services/email.ts). Errors are logged, not thrown,
        so one failed email doesn't block the in-app notification or the
        rest of the recipient list. */
    emailFn?: (recipientEmail: string, recipientName: string) => Promise<unknown>;
}

interface PreferenceRow {
    email_enabled: boolean;
    in_app_enabled: boolean;
}

async function getPreference(userId: string, kind: NotificationKind): Promise<PreferenceRow> {
    const row = await dbGet<PreferenceRow>(
        'SELECT email_enabled, in_app_enabled FROM notification_preferences WHERE user_id = $1 AND notification_kind = $2',
        [userId, kind]
    );
    return row ?? { email_enabled: true, in_app_enabled: true };
}

export async function notifyUsers(userIds: string[], input: NotifyInput): Promise<void> {
    if (userIds.length === 0) return;

    for (const userId of userIds) {
        const pref = await getPreference(userId, input.kind);

        if (pref.in_app_enabled) {
            await dbRun(
                `INSERT INTO notifications (id, recipient_user_id, kind, title, body, link)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [nanoid(), userId, input.kind, input.title, input.body, input.link ?? null]
            );
        }

        if (input.emailFn && pref.email_enabled) {
            const user = await dbGet<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = $1', [userId]);
            if (user) {
                try {
                    await input.emailFn(user.email, user.name);
                } catch (err) {
                    console.error(`Notification email failed for ${input.kind} → ${user.email}:`, err);
                }
            }
        }
    }
}

export async function notifyPortal(portal: 'admin' | 'ops' | 'hr' | 'studio', input: NotifyInput, companyId?: string): Promise<void> {
    const rows = companyId
        ? await dbAll<{ id: string }>(`SELECT id FROM users WHERE portal = $1 AND company_id = $2 AND status = 'active'`, [portal, companyId])
        : await dbAll<{ id: string }>(`SELECT id FROM users WHERE portal = $1 AND status = 'active'`, [portal]);

    await notifyUsers(rows.map((r) => r.id), input);
}
