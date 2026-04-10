# TP.Finance Outreach Engine

Private email outreach dashboard. Node.js + TypeScript backend, React + Vite frontend. Sends personalized email sequences via Gmail API, tracks opens/clicks/replies, monitors Dripify LinkedIn automation, syncs contacts from Apollo.io.

## Directory Structure

```
tp-outreach/
├── src/                        # Backend (Node.js + TypeScript)
│   ├── index.ts                # Express server, auth, tracking, OAuth routes
│   ├── types/index.ts          # All TypeScript interfaces
│   ├── db/
│   │   ├── connection.ts       # pg Pool + query helper
│   │   ├── migrate.ts          # Runs SQL migrations
│   │   └── migrations/
│   │       └── 001_initial.sql # Full schema
│   ├── middleware/
│   │   └── auth.ts             # requireAuth (session), requireApiKey
│   ├── routes/
│   │   ├── campaigns.ts        # Sequence CRUD + enrollment
│   │   ├── contacts.ts         # Contact CRUD + CSV import
│   │   ├── templates.ts        # Template CRUD + preview
│   │   ├── analytics.ts        # Overview, daily, accounts, campaigns
│   │   └── settings.ts         # Settings + email account management
│   ├── services/
│   │   ├── gmail-client.ts     # Gmail OAuth + send + reply polling
│   │   ├── template-engine.ts  # Merge field rendering + preview
│   │   ├── sequence-engine.ts  # Enrollment, step scheduling, BullMQ
│   │   ├── send-queue.ts       # BullMQ worker for email sends
│   │   ├── reply-watcher.ts    # Gmail reply polling + enrollment cancellation
│   │   ├── apollo-sync.ts      # Apollo.io contact sync
│   │   └── dripify-monitor.ts  # Dripify snapshot ingest + alerts
│   └── jobs/
│       └── worker.ts           # BullMQ workers + node-cron jobs
├── client/                     # Frontend (React + Vite + Tailwind)
│   ├── index.html
│   ├── vite.config.ts          # Proxy /api and /t to :3100
│   ├── tailwind.config.js
│   └── src/
│       ├── App.tsx             # Router, auth gate, sidebar layout
│       ├── lib/api.ts          # All typed API calls (axios)
│       └── pages/
│           ├── Login.tsx
│           ├── Analytics.tsx
│           ├── Campaigns.tsx
│           ├── CampaignDetail.tsx
│           ├── Contacts.tsx
│           ├── Templates.tsx
│           ├── Dripify.tsx
│           └── Settings.tsx
├── tampermonkey/
│   └── dripify-scraper.user.js # Tampermonkey script for Dripify
├── package.json
├── tsconfig.json
└── .env.example
```

## Running the Project

### Prerequisites
- Node.js 20+
- PostgreSQL (running, with a database created)
- Redis (running on default port 6379)

### Setup

```bash
# 1. Install backend deps
cd /root/tp-outreach
npm install

# 2. Install frontend deps
cd client && npm install && cd ..

# 3. Copy and configure env
cp .env.example .env
# Edit .env with your actual values

# 4. Run database migrations
npm run migrate
```

### Development

```bash
# Terminal 1: Backend API server (port 3100)
npm run dev

# Terminal 2: Background workers + cron jobs
npm run worker

# Terminal 3: React frontend (port 5173)
cd client && npm run dev
```

Open http://localhost:5173 — logs in with DASHBOARD_PASSWORD.

### Production Build

```bash
# Build backend
npm run build

# Build frontend (outputs to /public)
cd client && npm run build && cd ..

# Serve
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `APOLLO_API_KEY` | Apollo.io API key for contact sync |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match Google Console (e.g. `http://localhost:3100/api/auth/gmail/callback`) |
| `DRIPIFY_INGEST_KEY` | Secret key for Tampermonkey Dripify ingest endpoint |
| `TRACKING_DOMAIN` | Base URL for open/click tracking pixels |
| `SESSION_SECRET` | Long random string for session signing |
| `DASHBOARD_PASSWORD` | Password for the web dashboard |
| `PORT` | Server port (default 3100) |
| `NODE_ENV` | `development` or `production` |

## Adding Gmail Accounts (OAuth Flow)

1. Create a Google Cloud project and enable the Gmail API.
2. Create OAuth 2.0 credentials (Web Application type).
3. Add `GOOGLE_REDIRECT_URI` to the authorised redirect URIs in Google Console.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` in `.env`.
5. In the dashboard, go to **Settings** and click **Connect Gmail**.
6. Complete the Google OAuth consent screen — the account is saved to `email_accounts` table.
7. Multiple accounts can be connected. The sequence engine round-robins them respecting per-account limits.

## Updating the Tampermonkey Script

1. Edit `tampermonkey/dripify-scraper.user.js`.
2. Bump the `@version` number.
3. In Tampermonkey dashboard, edit the script and paste the new content (or use the file:// approach in developer mode).
4. The script auto-scrapes Dripify every 5 minutes and on navigation events.
5. Click the **TP** button (bottom-right of Dripify) to configure the ingest URL and API key.
6. The ingest key must match `DRIPIFY_INGEST_KEY` in your `.env`.

## Key Architecture Decisions

### Email Sending Flow
1. `SequenceEngine.enrollContact()` creates a `sequence_enrollments` record and schedules step 1 in BullMQ with `delay=0`.
2. `SequenceEngine.processStep()` (called by BullMQ worker) renders the template, picks a sending account, creates an `email_sends` record, and adds a job to the `email-sends` BullMQ queue with a random 30-120s delay.
3. `SendQueue` worker processes the email-sends job and calls `GmailClient.sendEmail()`, then updates the record with `gmail_message_id` and `gmail_thread_id`.
4. If successful, schedules the next step with the configured delay, adjusted for send window and weekends.

### Reply Detection
- `ReplyWatcher.pollAllAccounts()` runs every 5 minutes (via cron) and on-demand.
- Calls Gmail API `messages.list` for each account, looking for inbox messages since the last poll.
- Matches messages by `gmail_thread_id` to outbound `email_sends`.
- If a match is found and `stop_on_reply=true` on the sequence, cancels the enrollment.

### Send Window Logic
When scheduling a step, `SequenceEngine.adjustForWindow()` checks:
- Is the scheduled time on a weekend? (if `skip_weekends=true`) → advance to Monday 08:00 UTC.
- Is the time before `send_window_start`? → advance to window start.
- Is the time after `send_window_end`? → advance to next day's window start.

### A/B Testing
Steps can have a `variant_template_id` and `variant_split` percentage. At runtime, a random roll determines which template (A or B) is used. The `ab_variant` column on `email_sends` records which variant was sent.

### Dripify Monitoring
The Tampermonkey script scrapes the Dripify UI and POSTs to `/api/dripify/ingest` (authenticated with `DRIPIFY_INGEST_KEY`). The `DripifyMonitor` service stores snapshots and auto-creates alerts when credits are low or limits are near capacity.
