/**
 * scripts/send-daily-menu.ts
 *
 * Sends today's menu + remaining allowance to every active employee, by
 * email (and SMS if they've opted in and have a phone on file). Meant to
 * run twice a day via a scheduled job — once for breakfast, once for
 * lunch — NOT continuously inside the API server, so a slow email batch
 * can't block request handling.
 *
 * Usage:
 *   npm run send-daily-menu -- --window=breakfast
 *   npm run send-daily-menu -- --window=lunch
 *
 * Suggested cron (Render Cron Job, GitHub Actions schedule, or plain
 * crontab on a box that has this repo):
 *   0 7  * * 1-5   npm run send-daily-menu -- --window=breakfast   (7:00 AM Lagos)
 *   0 10 * * 1-5   npm run send-daily-menu -- --window=lunch       (10:00 AM Lagos, matches the order cutoff)
 *
 * Add a script to package.json:
 *   "send-daily-menu": "tsx scripts/send-daily-menu.ts"
 * (or `ts-node`/compiled `node dist/...` depending on how you run the rest of the app)
 */

import 'dotenv/config';
import { initDb, dbAll, closeDb } from '../src/db/index.js';
import { sendDailyMenuEmail } from '../src/services/email.js';
import { sendSms } from '../src/services/sms.js';

type MealWindow = 'breakfast' | 'lunch';

function getWindowArg(): MealWindow {
    const arg = process.argv.find((a) => a.startsWith('--window='));
    const value = arg?.split('=')[1];
    if (value !== 'breakfast' && value !== 'lunch') {
        console.error('Usage: send-daily-menu -- --window=breakfast|lunch');
        process.exit(1);
    }
    return value;
}

function formatCutoff(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
}

async function main() {
    const window = getWindowArg();
    await initDb();

    const today = new Date().toISOString().slice(0, 10);

    const menu = await dbAll<any>(
        `SELECT mm.date, mm.cutoff_time, m.name, m.price
         FROM menu_meals mm
         JOIN menus me ON me.id = mm.menu_id
         JOIN meals m ON m.id = mm.meal_id
         WHERE me.published = TRUE AND mm.meal_window = $1 AND mm.date = $2
         ORDER BY m.name`,
        [window, today]
    );

    if (menu.length === 0) {
        console.log(`No published ${window} menu for ${today}. Nothing to send.`);
        await closeDb();
        return;
    }

    const cutoffTime = formatCutoff(menu[0].cutoff_time);
    const meals = menu.map((m) => ({ name: m.name, price: m.price }));

    const employees = await dbAll<any>(
        `SELECT u.id, u.name, u.email, u.phone, u.notify_email, u.notify_sms,
                u.company_id, u.allowance_override_lunch, u.allowance_override_breakfast,
                ar.daily_amount, ar.daily_amount_breakfast
         FROM users u
         JOIN companies c ON c.id = u.company_id AND c.status = 'active'
         LEFT JOIN allowance_rules ar ON ar.company_id = u.company_id
         WHERE u.portal = 'employee' AND u.status = 'active'`
    );

    let emailsSent = 0;
    let smsSent = 0;

    for (const emp of employees) {
        const override = window === 'breakfast' ? emp.allowance_override_breakfast : emp.allowance_override_lunch;
        const companyDefault = window === 'breakfast' ? emp.daily_amount_breakfast : emp.daily_amount;
        const allowanceRemaining = override ?? companyDefault ?? 0;

        // Skip employees whose company plan doesn't cover this window at all.
        if (!allowanceRemaining || allowanceRemaining <= 0) continue;

        if (emp.notify_email && emp.email) {
            const result = await sendDailyMenuEmail(emp.email, {
                employeeName: emp.name,
                mealWindow: window,
                meals,
                allowanceRemaining,
                cutoffTime,
            });
            if (result.sent) emailsSent++;
        }

        if (emp.notify_sms && emp.phone) {
            const mealList = meals.map((m) => m.name).join(', ');
            const result = await sendSms(
                emp.phone,
                `Manna ${window}: ${mealList}. You have ₦${allowanceRemaining.toLocaleString('en-NG')} available. Order by ${cutoffTime}.`
            );
            if (result.sent) smsSent++;
        }
    }

    console.log(`Daily ${window} notification complete: ${emailsSent} emails, ${smsSent} SMS sent to ${employees.length} employees checked.`);
    await closeDb();
}

main().catch((err) => {
    console.error('send-daily-menu failed:', err);
    process.exit(1);
});
