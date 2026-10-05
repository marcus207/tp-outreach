#!/usr/bin/env bash
# TP.Finance sender warm-up ramp.
# Steps each tp account's daily_limit up by +10/day toward a 150 ceiling and
# scales hourly_limit to ceil(daily/4), capped at 20. Runs daily before the
# send window. Reputation recovery after the 24 Jun spam-folder hit — see
# project_deliverability_spam_placement_jul7 memory.
# Remove the cron (crontab -e) once accounts reach the ceiling to stop stepping.
set -euo pipefail

DB="$(grep -E '^DATABASE_URL=' /root/tp-outreach/.env | cut -d= -f2-)"
CEILING=150
STEP=10

psql "$DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE email_accounts
SET daily_limit  = LEAST(daily_limit + ${STEP}, ${CEILING}),
    hourly_limit = LEAST(CEIL(LEAST(daily_limit + ${STEP}, ${CEILING}) / 4.0)::int, 20),
    updated_at   = NOW()
WHERE tenant = 'tp' AND is_active = true AND daily_limit < ${CEILING};
SQL

echo "[warmup_ramp] $(date -u +%FT%TZ) stepped tp daily_limit +${STEP} (ceiling ${CEILING})"
psql "$DB" -tA -F' | ' -c "SELECT email, daily_limit, hourly_limit FROM email_accounts WHERE tenant='tp' ORDER BY email;"
