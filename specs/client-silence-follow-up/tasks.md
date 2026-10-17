# Tasks

## MVP (PR #1112, migration 20261017090000)

- [x] Fresh-check: trunk `fa0fda88`, production 298 migrations, md5 of every replaced function equal to local
- [x] Migration
- [x] pgTAP 339; 050 and 296 adjusted; full suite and `db lint`
- [x] CRM UI and tests; typecheck, build, mobile first-screen check
- [x] Parity and MCP Stage 2 inventory
- [x] Exact-head CI on `f918aed7`, merge `797d374a`, private production release (run 39015299422, all jobs green)
- [x] Operator host: host-split `deploy-internal` (run 39016338852); Cloudflare canonical deployment of `vishar-crm-internal` (alias app.vishartattoo.com) is `797d374a`; app and `*.pages.dev` answer 302 to Cloudflare Access
- [x] Production readback: no silence item from a reaction, automation, system email or cleared Today item; Today latency against the 2026-10-17 baseline

## Acceptance (production, 2026-10-17, read-only or rolled back)

- [x] Counter equals the Today block: owner 15/15 (all), 15/15 (Vladimir), 0/0 (Kristina)
- [x] Isolation: Kristina's manager sees only Kristina (0 rows, no Vladimir row); an explicit Vladimir count is denied 42501
- [x] Operator actions through the production RPCs in one transaction, rolled back (nothing persisted, checked after):
  - "later 3 days": 15 → 14 in Statistics and Today, row stored with `resurface_at` +72 h, `attention.snoozed` logged
  - the same row is hidden at now+2 days and back at now+4 days
  - undo: back to 15; "don't remind": 14, `attention.dismissed`; undo: 15, `attention.restored`
  - a decision for an older cycle does not hide the current one (15)
  - a past snooze, a snooze over 366 days and a snooze on another kind are refused (22023)
  - Kristina's manager: snooze, dismiss and undo on Vladimir's item are refused (42501); anon is refused (42501)
- [x] One row per client: 15 rows, 15 clients; no client both in "reply" and "waiting on the client"
- [x] Today latency: 583–886 ms for 5 artists, 464 ms for Vladimir (baseline 470–800 ms)

## Fail-safe reaction rule (migration 20261017140000)

- [x] A reaction closes only a plain thank-you or goodbye, or a message with an exact `no_reply_needed` mark; requests without a question mark, agreements, thumbs-up and photos stay open; no classifier mark means open
- [x] pgTAP 339 scenarios and vocabulary checks; 326 fixture says "Thank you!"; full suite 214 files / 6020 checks; `db lint`
- [x] Production impact measured before release (rolled back): 9 conversations closed only by a reaction; 3 have `no_reply_needed` on that message and stay closed; 6 open again (5 texts the rule cannot read as thanks, 1 photo); the release readback below shows where they land in Today
- [x] Exact-head CI on `26af220d` (two Codex findings fixed before merge: kisses close, bare punctuation does not), merge `badd4886`, private production release (run 39047768953, all jobs green, no migrations left)
- [x] Production readback after release: 300 migrations, latest `20261017140000`; md5 of `is_closing_message` and `studio_reaction_acknowledged_at` equal the merge; no grant to anon, authenticated or service_role; "Thank you!" and "xx" close, the Saturday request and "..." do not
- [x] Effect: 12 conversations answered only by a reaction; 3 stay closed (exact `no_reply_needed`); 9 open: 2 linked clients already in "reply" (reply_required), 7 unknown senders counted in the grouped "unmatched inbound" card (Vladimir 6, Kristina 4), no new per-row noise; counter equals Today (15/15)

## Not in scope

- [ ] Reaction emoji and target storage (model in spec.md)
- [ ] GPT/MCP `snoozeAttentionItem`
- [ ] Per-project silence: the cycle stays per client; a project-specific reminder is a manual follow-up
