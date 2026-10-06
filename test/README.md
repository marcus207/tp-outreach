# tp-outreach test harness

Two suites:

| Suite | Location | Command | Touches |
|---|---|---|---|
| Unit | `src/__tests__/**` | `npm run test:unit` | nothing (DB, BullMQ and Gmail are mocked) |
| Integration | `test/integration/**` | `npm run test:integration` | `tpca_outreach_test` DB + Redis DB 15 only |

`npm test` runs both. `npm run test:db:reset` rebuilds the test DB by hand.

## Running

```bash
cd /root/tp-outreach
npm run test:integration          # resets the test DB, then runs test/integration/**/*.test.ts
npx vitest run --config vitest.integration.config.ts test/integration/smoke.test.ts   # one file
```

Prerequisites: local Postgres with database `tpca_outreach_test` owned by `tpca`
(the reset script creates it via `sudo -u postgres createdb -O tpca` if it is missing,
because `tpca` has no CREATEDB), and local Redis.

## Safety guarantees

The integration suite cannot touch production. Each guarantee is enforced in code,
most of them twice:

1. **Database.** `vitest.integration.config.ts` pins `DATABASE_URL` to `tpca_outreach_test`
   before anything loads, so dotenv never pulls the prod URL from `.env` (dotenv does not
   override variables that are already set). `global-setup.ts` and `setup.ts` abort if the URL
   does not end in `/tpca_outreach_test`. `src/db/connection.ts` refuses any other database
   whenever `NODE_ENV=test`. `scripts/test-db-reset.sh` refuses any other database name and
   checks `current_database()` again before it drops anything. `resetDb()` checks it a third time
   before each TRUNCATE.
2. **Redis / BullMQ.** `REDIS_URL=redis://127.0.0.1:6379/15` and `BULL_PREFIX=bull-test`.
   `src/db/redis.ts` throws under `NODE_ENV=test` for any logical DB other than 15, and
   `connection.ts` throws if the prefix does not start with `bull-test`. Prod uses DB 0 and the
   `bull-tp` prefix. Cleanup deletes only `bull-test*` keys in DB 15 after confirming
   `CLIENT INFO` reports `db=15`. It never runs FLUSHDB.
3. **No real email.** `GmailClient.sendEmail()` only calls Gmail when `SEND_MODE=live`.
   The suite runs with `SEND_MODE=dryrun`, so every outreach send is written to the test-only
   `test_outbox` table (full From/To/Subject/HTML/text, every header including
   `List-Unsubscribe`, the raw RFC 822 message, threadId) and gets a fake message and thread id.
   Outside `NODE_ENV=test`, a non-live send logs and throws `SEND_MODE is not live`.
4. **No Gmail API at all.** `setGmailTransportForTests(fakeGmail.factory)` swaps the shared
   `google.gmail` factory. Every module (reply-watcher, digest, draft-review, health-check,
   routes) builds its Gmail client from that factory, so reads, forwards, archive and trash calls
   all go to the in-memory `FakeGmail`. The seam throws outside `NODE_ENV=test`.
5. **No network.** `setup.ts` patches `http`/`https` `request`/`get` and `fetch` so that any
   non-loopback host throws (`[integration net-guard]`). API keys are blanked in the config.
6. **No crons, no workers.** `src/jobs/worker.ts` is never imported. `src/index.ts` exports
   `app` and does not call `listen()` under `NODE_ENV=test`. Supertest drives it in-process.

`test/integration/safety.test.ts` asserts these guarantees on every run.

## Architecture

```
vitest.integration.config.ts   env pinning, sequential (fileParallelism off, 1 worker)
test/integration/
  safety.ts         isolation assertions (shared)
  global-setup.ts   assert env -> scripts/test-db-reset.sh -> clear bull-test* in DB 15
  setup.ts          per-worker assert + network guard
  fake-gmail.ts     in-memory Gmail double: injectReply / injectOOO / injectBounce, captures `sent`
  factories.ts      fixtures + drivers (below)
  smoke.test.ts     end-to-end proof of the harness
  safety.test.ts    the guarantees above, asserted
test/schema.sql     schema-only dump of the outreach tables + test_outbox
scripts/test-db-reset.sh
```

### Factories and drivers (`factories.ts`)

- `createAccount({ email, limits: { daily, hourly }, active })`. OAuth tokens are fake
  (`access_token = fake-access:<email>`, which routes FakeGmail calls to that mailbox).
- `createContact({ email, type, subsector, tags, tenant })`, `createTemplate`,
  `createSequence({ accountIds, steps: [{ subject, bodyHtml, delayDays }] })`,
  `enroll(seqId, contactId)` (the production `enrollContact`, so all refusal rules apply),
  `suppress(email, { domain, source })`.
- `setClock(date = MON_10_LONDON)` fakes only `Date` (Mon 5 Oct 2026 10:00 Europe/London).
  Timers stay real so pg, ioredis and BullMQ work. `restoreClock()`.
- `runPlannerPass()` runs `dailyPlanner.plan()`.
- `drainSendQueue()`: see below.
- `runReplyWatcher()` runs `replyWatcher.pollAllAccounts()` against FakeGmail.
- Readers: `outbox()`, `emailSends()`, `enrollment(id)`, `isEmailSuppressed(email)`, `pendingSendJobs()`.
- `resetAll()` truncates all tables, clears `bull-test*` keys and resets FakeGmail.
  `closeAll()` goes in `afterAll`.

**Queue processing choice.** The planner enqueues real BullMQ jobs into Redis DB 15, exactly
as prod does. `drainSendQueue()` reads the delayed and waiting jobs back, removes them, and calls
the production `SendQueue.processEmailSend(job.data)` synchronously. That covers the real
payload and the whole send path (gate, claim, sendEmail, status update, next-step scheduling)
without BullMQ worker timing (0-55 min jitter, lock renewals), so runs are deterministic.
Jobs that get re-queued during a drain (the per-account send-gap push-back) wait for the next drain.

### Known limitation: two clocks

`setClock` moves JS time only. Postgres `NOW()` (enrolment due times, `last_send_at`,
`planner due <= NOW()`) is still the real clock. Tests that care should set DB timestamps
directly, as the smoke test does when it forces step 2 due.

## Refreshing the schema

When prod outreach tables change, regenerate `test/schema.sql`. This is read-only against prod:

```bash
T="_migrations apollo_sync_log article_broadcasts article_drafts campaign_schedule campaign_sends \
campaign_settings contact_list_members contact_lists contacts daily_digest daily_send_plans \
deliverability_checks dmarc_reports dripify_alerts dripify_snapshots email_accounts email_events \
email_sends gmail_scanned_messages kv_store press_contacts press_releases sequence_enrollments \
sequence_steps sequences session settings suppressed_emails template_draft_reviews \
template_rotations templates"
pg_dump -h localhost -U tpca -d tpca_platform --schema-only --no-owner --no-privileges \
  $(for t in $T; do printf -- '-t public.%s ' $t; done) | grep -v '^\\restrict\|^\\unrestrict'
```

Keep the header (`CREATE EXTENSION pgcrypto`) and the `test_outbox` block at the bottom of the
file. If new code references a new table, add it to the list.

## Production switch

Prod `.env` contains `SEND_MODE=live`. Without it, the API and worker will refuse to send after
their next restart. That is the intended fail-safe.

## Database credentials

No password is stored in this repository. Test tooling connects as `postgresql://tpca@localhost/...`
and libpq / node-postgres read the password from `~/.pgpass` (mode 600):

```
localhost:5432:*:tpca:<password>
```

In CI the Postgres service container provides its own throwaway credentials via `PGPASSWORD`.
