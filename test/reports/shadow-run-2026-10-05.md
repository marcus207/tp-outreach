# Shadow run 2026-10-05

Read-only copy of prod (tpca_platform) -> `tpca_outreach_test_shadow`, SEND_MODE=dryrun, simulated Mon, 05/10/2026, 21:00 -> Tue, 13/10/2026, 00:00 (5 weekdays, Europe/London).
Shadow-only change: marcus.emadi@go.tp.finance set to warm-up 10/day, 2/hr. Wall time 361s.

## Headline

- **Simulated sends: 50** (budget 5 x 10 = 50)
- Active tp enrolments at start: 10197; due now: 4867; active with no due date (stranded): 4592
- Enrolments cancelled during the run (planner/gate refusals): 0
- Invariants: **ALL ZERO**
- Planner pass: p50 7666 ms, max 10177 ms over 45 in-window passes. Gate: p50 1.8 ms, max 5.3 ms.

## INVARIANTS (all must be 0)

| check | count | result |
|---|---|---|
| recipient is a lender (contact_type) | 0 | PASS |
| recipient suppressed (exact or manual domain) | 0 | PASS |
| recipient tagged unsubscribed/bounced/hold | 0 | PASS |
| previously replied (any 'reply' event ever, or replied enrolment) | 0 | PASS |
| previously bounced (any bounce event ever) | 0 | PASS |
| loan-intel tenant contact | 0 | PASS |
| same contact emailed by the same step within the previous 7 days | 0 | PASS |
| sender on @tp.finance (root domain) | 0 | PASS |
| sender not on @go.tp.finance | 0 | PASS |
| weekend send (Europe/London) | 0 | PASS |
| outside 08:00-17:00 Europe/London | 0 | PASS |
| merge-field leftovers '{{' (subject/html/text) | 0 | PASS |
| empty greeting ('Hey ,' / 'Hi ,' / 'Dear ,') | 0 | PASS |
| bare 'Turning Point Capital' without 'Advisory' | 0 | PASS |
| base64 images (data:image / ;base64,) | 0 | PASS |
| same enrolment+step sent twice (ever) | 0 | PASS |

Informational:

| check | count |
|---|---|
| recipient emailed by ANY sequence/step in the previous 7 days (cross-sequence) | 0 |
| recipient address also exists as a loan-intel tenant contact | 0 |
| recipient looks like a no-reply / notification / newsletter address | 4 |
| recipient emailed more than once during the shadow week | 0 |

## Sends per day

| day | sends |
|---|---|
| 2026-10-06 Tue | 10 |
| 2026-10-07 Wed | 10 |
| 2026-10-08 Thu | 10 |
| 2026-10-09 Fri | 10 |
| 2026-10-12 Mon | 10 |

## Sends per day/hour

| slot | sends |
|---|---|
| 2026-10-06 Tue 08:00 | 2 |
| 2026-10-06 Tue 09:00 | 2 |
| 2026-10-06 Tue 10:00 | 2 |
| 2026-10-06 Tue 11:00 | 1 |
| 2026-10-06 Tue 12:00 | 2 |
| 2026-10-06 Tue 13:00 | 1 |
| 2026-10-07 Wed 08:00 | 2 |
| 2026-10-07 Wed 09:00 | 2 |
| 2026-10-07 Wed 10:00 | 2 |
| 2026-10-07 Wed 11:00 | 2 |
| 2026-10-07 Wed 12:00 | 2 |
| 2026-10-08 Thu 08:00 | 2 |
| 2026-10-08 Thu 09:00 | 2 |
| 2026-10-08 Thu 10:00 | 2 |
| 2026-10-08 Thu 11:00 | 2 |
| 2026-10-08 Thu 12:00 | 1 |
| 2026-10-08 Thu 13:00 | 1 |
| 2026-10-09 Fri 08:00 | 2 |
| 2026-10-09 Fri 09:00 | 2 |
| 2026-10-09 Fri 10:00 | 2 |
| 2026-10-09 Fri 11:00 | 2 |
| 2026-10-09 Fri 12:00 | 2 |
| 2026-10-12 Mon 08:00 | 2 |
| 2026-10-12 Mon 09:00 | 2 |
| 2026-10-12 Mon 10:00 | 2 |
| 2026-10-12 Mon 11:00 | 2 |
| 2026-10-12 Mon 12:00 | 2 |

## Recipients by contact_type

| contact_type | sends |
|---|---|
| introducer | 42 |
| developer | 8 |

## Recipients by subsector

| subsector | sends |
|---|---|
| wealth | 36 |
| living | 8 |
| advisory | 6 |

## By sequence / step

| sequence_step | sends |
|---|---|
| Introducers — Wealth \| step 6 | 35 |
| Clients — Living \| step 1 | 6 |
| Introducers — Advisory \| step 1 | 6 |
| Clients — Living \| step 6 | 1 |
| Clients — Living \| step 2 | 1 |
| Introducers — Wealth \| step 1 | 1 |

## Templates / subjects going out

| template | subject | sends |
|---|---|---|
| Introducers - Wealth - Let's Connect | Quick catch up referral partnership | 35 |
| Clients - Living - Sector Overview | Living sector debt advisory BTR, co living & residential | 6 |
| Introducers - Advisory - Partnership Intro | Referral partnership debt advisory for your advisory clients | 6 |
| Clients - Living - Partnership Call | Quick catch up living sector finance pipeline | 1 |
| Clients - Living - Development Finance | Living sector development finance BTR & co living schemes | 1 |
| Introducers - Wealth - Partnership Intro | Referral partnership debt advisory for your wealth management clients | 1 |

## First 20 rendered subjects

| # | sent_london | to | sequence | step | subject |
|---|---|---|---|---|---|
| 1 | Tue, 06/10/2026, 08:30 | ha***@sunsethospitality.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 2 | Tue, 06/10/2026, 08:35 | d.***@smartspaces.app | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 3 | Tue, 06/10/2026, 09:10 | na***@robertwalters.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 4 | Tue, 06/10/2026, 09:15 | in***@enews.wealthmanagement.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 5 | Tue, 06/10/2026, 10:35 | la***@museplaces.com | Clients — Living | 6 | Quick catch up living sector finance pipeline |
| 6 | Tue, 06/10/2026, 10:40 | ne***@neom.com | Clients — Living | 2 | Living sector development finance BTR & co living schemes |
| 7 | Tue, 06/10/2026, 11:50 | ao***@apollojets.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 8 | Tue, 06/10/2026, 12:00 | he***@fuel.ventures | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 9 | Tue, 06/10/2026, 12:15 | am***@westlondon.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 10 | Tue, 06/10/2026, 13:10 | se***@brave.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 11 | Wed, 07/10/2026, 08:25 | st***@hubfinance.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 12 | Wed, 07/10/2026, 08:45 | st***@skyfold.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 13 | Wed, 07/10/2026, 09:45 | sa***@workspacedesign.co.uk | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 14 | Wed, 07/10/2026, 09:50 | wi***@notifications.wix.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 15 | Wed, 07/10/2026, 10:10 | sa***@renews.biz | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 16 | Wed, 07/10/2026, 10:15 | su***@eclipsepower.co.uk | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 17 | Wed, 07/10/2026, 11:40 | ro***@finito.org.uk | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 18 | Wed, 07/10/2026, 11:55 | wo***@fairmas.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 19 | Wed, 07/10/2026, 12:20 | us***@user.luma-mail.com | Introducers — Wealth | 6 | Quick catch up referral partnership |
| 20 | Wed, 07/10/2026, 12:50 | we***@parking.net | Introducers — Wealth | 6 | Quick catch up referral partnership |

Rendered HTML samples: `test/reports/samples/shadow-run-2026-10-05-1.html`, `test/reports/samples/shadow-run-2026-10-05-2.html`, `test/reports/samples/shadow-run-2026-10-05-3.html`

## Overdue enrolments (at sim start)

| step | due_now | over_30d | over_90d | oldest_due |
|---|---|---|---|---|
| 1 | 455 | 228 | 0 | 2026-08-16 |
| 2 | 272 | 145 | 0 | 2026-08-15 |
| 3 | 684 | 71 | 0 | 2026-09-02 |
| 4 | 359 | 229 | 0 | 2026-08-17 |
| 5 | 538 | 447 | 0 | 2026-08-16 |
| 6 | 2559 | 1742 | 0 | 2026-08-15 |

Over 30 days overdue, by sequence/step (top 25):

| sequence | step | over_30d |
|---|---|---|
| Introducers — Wealth | 6 | 788 |
| Introducers — Advisory | 6 | 172 |
| Clients — Living | 6 | 151 |
| Clients — Living | 5 | 99 |
| Clients — Hospitality | 6 | 78 |
| Introducers — Construction | 6 | 74 |
| Clients — Offices | 6 | 69 |
| Introducers — Agent | 6 | 68 |
| Clients — Living | 1 | 67 |
| Introducers — Lawyer | 6 | 60 |
| Clients — Logistics | 6 | 59 |
| Introducers — Advisory | 5 | 58 |
| Clients — Living | 4 | 56 |
| Clients — SFH | 6 | 45 |
| Introducers — Planning / Architect | 6 | 44 |
| Clients — Living | 2 | 41 |
| Introducers — Advisory | 1 | 38 |
| Clients — BTR | 6 | 36 |
| Clients — Hospitality | 5 | 33 |
| Clients — Care | 5 | 33 |
| Clients — Offices | 5 | 33 |
| Clients — Logistics | 5 | 32 |
| Introducers — Construction | 5 | 32 |
| Introducers — Surveyor | 6 | 31 |
| Clients — Care | 3 | 29 |

10 most-overdue enrolments, and whether the shadow week sent them:

| enrolment | contact | type | sequence | seq_status | step | due | days_overdue | sent_in_shadow |
|---|---|---|---|---|---|---|---|---|
| 569c7f8d | d.***@smartspaces.app | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 11:58 | 51 | yes (#2, Tue, 06/10/2026, 08:35) |
| 63f0d1fb | ha***@sunsethospitality.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 12:05 | 51 | yes (#1, Tue, 06/10/2026, 08:30) |
| 6896f6df | in***@enews.wealthmanagement.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 12:15 | 51 | yes (#4, Tue, 06/10/2026, 09:15) |
| 1dc79b9f | na***@robertwalters.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 12:20 | 51 | yes (#3, Tue, 06/10/2026, 09:10) |
| dba4fd12 | la***@museplaces.com | developer | Clients — Living | active | 6 | Sat, 15/08/2026, 13:58 | 51 | yes (#5, Tue, 06/10/2026, 10:35) |
| aa7f52d8 | ne***@neom.com | developer | Clients — Living | active | 2 | Sat, 15/08/2026, 14:05 | 51 | yes (#6, Tue, 06/10/2026, 10:40) |
| b87e934d | he***@fuel.ventures | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 14:07 | 51 | yes (#8, Tue, 06/10/2026, 12:00) |
| fe74a2d7 | ao***@apollojets.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 14:20 | 51 | yes (#7, Tue, 06/10/2026, 11:50) |
| cae5a85e | am***@westlondon.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 14:24 | 51 | yes (#9, Tue, 06/10/2026, 12:15) |
| 8ce6f4ea | se***@brave.com | introducer | Introducers — Wealth | active | 6 | Sat, 15/08/2026, 14:45 | 51 | yes (#10, Tue, 06/10/2026, 13:10) |

Due enrolments whose address looks like a no-reply / notification / newsletter mailbox: 20

## Stranded: active enrolments with no next_step_due_at (the planner never picks these up)

| step | last_send | enrolments |
|---|---|---|
| 4 | (no send in last 120d) | 1864 |
| 1 | (no send in last 120d) | 1025 |
| 3 | (no send in last 120d) | 749 |
| 4 | cancelled: stale queued send cancelled (Oct 5 audit) | 291 |
| 5 | cancelled: stale queued send cancelled (Oct 5 audit) | 127 |
| 1 | cancelled: stale queued send cancelled (Oct 5 audit) | 113 |
| 4 | failed: Invalid Credentials | 111 |
| 5 | failed: Invalid Credentials | 59 |
| 6 | failed: invalid_grant | 37 |
| 1 | failed: Invalid Credentials | 34 |
| 5 | failed: Mail service not enabled | 33 |
| 3 | cancelled: stale queued send cancelled (Oct 5 audit) | 27 |
| 2 | cancelled: stale queued send cancelled (Oct 5 audit) | 27 |
| 2 | (no send in last 120d) | 26 |
| 3 | failed: Invalid Credentials | 15 |

## Sequences: accounts and due load at start

| name | status | accounts | due_now |
|---|---|---|---|
| Introducers — Wealth | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 1074 |
| Clients — Living | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 916 |
| Introducers — Advisory | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 566 |
| Introducers — Construction | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 279 |
| Clients — Logistics | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 277 |
| Introducers — Agent | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 265 |
| Clients — Offices | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 253 |
| Clients — Care | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 228 |
| Clients — Hospitality | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 216 |
| Clients — SFH | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 153 |
| Clients — BTR | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 118 |
| Clients — Retail | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 113 |
| Introducers — Lawyer | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 103 |
| Introducers — Planning / Architect | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 102 |
| Introducers — Surveyor | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 97 |
| Clients — PBSA | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 58 |
| Introducers — Accountant | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 27 |
| Clients — Leisure | active | m.emadi@tp.finance, marcus@tp.finance, marcusemadi@tp.finance, marcus.emadi@go.tp.finance | 22 |
| Monthly Client Check-In | archived | (all) | 0 |
| Deliverability Test — 3 Emails / 3 Hours | archived | (all) | 0 |
| Marcus's Outbound Sequence | archived | (all) | 0 |
| IHIF 2026 | archived | (all) | 0 |
| Monthly Introducer Outreach | archived | (all) | 0 |

## Accounts (tp)

| email | is_active | daily_limit | hourly_limit |
|---|---|---|---|
| m.emadi@tp.finance | false | 0 | 0 |
| marcus.emadi@go.tp.finance | true | 10 | 2 |
| marcus@go.tp.finance | false | 0 | 0 |
| marcus@tp.finance | false | 0 | 0 |
| marcusemadi@tp.finance | false | 0 | 0 |

## Failed sends during the run

_none_

## Enrolment status after the run

| status | n |
|---|---|
| active | 10161 |
| cancelled | 2948 |
| completed | 53 |
| paused | 624 |

## Copy counts

| table | rows |
|---|---|
| contacts | 34851 |
| contact_lists | 6 |
| contact_list_members | 15812 |
| templates | 129 |
| sequences | 25 |
| sequence_steps | 128 |
| template_rotations | 0 |
| sequence_enrollments | 33837 |
| suppressed_emails | 28009 |
| settings | 15 |
| email_accounts | 8 |
| email_sends | 41619 |
| email_events | 28890 |
| history_flags | 40 |

CSV (one row per simulated send): `test/reports/shadow-run-2026-10-05.csv`
