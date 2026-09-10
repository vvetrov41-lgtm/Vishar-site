# Derived CRM AI state: production rollout runbook

Activates the derived client AI layer — the client brief, the Next Action and
reference-image analysis — on top of the CRM that already exists. It introduces
no cron, no second message store and no second Telegram queue: the work rides
the existing five-minute scheduler through the existing TattooAI Service
Binding, and artist alerts go through `public.notifications` exactly as the
enquiry path does.

Nothing in this document has been executed. This branch has not been deployed
and the production database has not been migrated.

## What this system may and may not do

It writes to four derived tables and nothing else. It cannot send a message,
hold a date, quote a price, request a deposit or confirm a booking, and no
configuration in this runbook can give it that ability:

- `approval_required` on a recommendation is a GENERATED column, so a model
  that returns `false` for a deposit request still produces an approval-gated
  row;
- the action types that could commit money, availability or a booking
  (`prepare_quote`, `offer_dates`, `request_deposit`, `confirm_booking`) may
  not carry model-written client text, in the Worker contract and again in a
  table constraint;
- any draft that does exist is re-checked against the same reply-safety rule
  the enquiry intake path uses;
- the Telegram surface is read-only.

If a brief and the CRM disagree, the CRM is right. `get_client_ai_state`
returns the live project/session facts beside the brief and flags the brief
stale by comparing watermarks, so a reader never has to guess which is current.

Staleness is not merely reported, it is acted on. A recommendation whose
watermark no longer matches is withheld from the Telegram digest and its
replacement queued, and an undelivered push for a recommendation that has
stopped being current is withdrawn before the connector claims it. A deposit
paid between generation and delivery therefore cannot arrive as "request a
deposit".

## Fixed runtime boundary

- Migrations, in order: `20260910160000_crm_agent_client_ai.sql`,
  `20260910170000_crm_agent_telegram_digest.sql`,
  `20260910180000_crm_agent_gmail_hook.sql`,
  `20260910190000_crm_agent_gmail_excerpts.sql`,
  `20260910200000_crm_agent_canonical_facts.sql`,
  `20260910210000_crm_agent_stale_actions.sql`,
  `20260910220000_crm_agent_final_guards.sql`,
  `20260910230000_crm_agent_contract_compat.sql`,
  `20260910240000_crm_agent_review_fixes.sql`,
  `20260910250000_crm_agent_convergence_guards.sql`.
- Worker library: `workers/lib/crm-agent.js`, drained through
  `POST https://tattooai.internal/internal/crm-agent/drain` on the `tattooai`
  Worker. The synthetic internal hostname is the capability boundary; the route
  is unreachable from the public Worker URL and never receives browser CORS.
- Scheduler: the existing `vishar-telegram-drain-production` cron. No new cron.
- Model tasks: `crm_client_state` and `vision_reference_extraction`, both
  Qwen-first through the existing router. No new provider and no new API key.
- Production Supabase project only: `vfjexhfdbrjmuxfdvbdx`.

## Switches

Every switch is off in the tracked configuration. Two of them must agree before
any job is claimed, so enabling one alone is inert by design.

| Switch | Where | Guards |
| --- | --- | --- |
| `crm_private.crm_agent_config.enabled` | database | scheduling and claiming |
| `crm_private.crm_agent_config.vision_enabled` | database | reading private Storage objects |
| `CRM_AGENT_ENABLED` | `tattooai` Worker | the drain doing anything |
| `CRM_AGENT_VISION_ENABLED` | `tattooai` Worker | the vision job type |
| `CRM_AGENT_SHARED_DRAIN_ENABLED` | scheduler Worker | dispatching the drain |
| `CRM_AGENT_TELEGRAM_DIGEST_ENABLED` | scheduler Worker | `/needsme` and `/today` |

No new secret is required. The drain reuses the `tattooai` Worker's existing
Supabase and `AI` binding; the digest reuses the scheduler's existing
`SUPABASE_SECRET_KEY` and `TELEGRAM_BOT_TOKEN`.

## Activation order

Each step is separately reversible, and each one leaves the system inert if the
next is never taken.

1. Fresh-check the exact head and confirm normal exact-head CI, including the
   pgTAP suite and `npm run test:worker`.
2. Apply the ten migrations listed above, in order. They create five tables, add triggers to
   `enquiries`, `communication_messages`, `communication_conversations`,
   `enquiry_files`, `projects`, `sessions`, `client_ai_next_actions` and
   `crm_private.gmail_thread_contexts`, and add no column to any existing
   table. Every trigger is AFTER and wrapped, and every scheduler
   short-circuits while `crm_agent_config.enabled` is false, so applying the
   migrations changes no existing behaviour. In particular the triggers on
   `projects` and `sessions` sit on the payment and booking paths: verify by
   inspection that each one's first act is the fingerprint comparison, and that
   its scheduling call is inside an exception block.
3. Verify the four new tables have RLS enabled and forced and that no API role
   holds a table grant. `supabase/tests/050_rls_roles.sql` asserts both, and its
   function allow-list now names every new callable.
4. Deploy the `tattooai` Worker with `CRM_AGENT_ENABLED=false`. The drain route
   exists and answers, and the drain itself does nothing.
5. Deploy the scheduler Worker with `CRM_AGENT_SHARED_DRAIN_ENABLED=false`.
6. Enable the database switch:
   `update crm_private.crm_agent_config set enabled = true;`
   Jobs now accumulate. Nothing processes them, which is the intended state for
   observing what the triggers actually queue on live traffic.
7. Inspect `public.crm_agent_jobs` for a normal working day. Confirm the volume
   matches real client activity and that `source_event_id` values are the
   expected identifiers.
8. Set `CRM_AGENT_ENABLED=true` on the `tattooai` Worker, then
   `CRM_AGENT_SHARED_DRAIN_ENABLED=true` on the scheduler. Briefs and
   recommendations begin to appear, and approval-gated recommendations begin to
   produce notifications, which the existing Telegram connector delivers.
9. Only once text is behaving, enable vision: `CRM_AGENT_VISION_ENABLED=true`
   on the Worker and
   `update crm_private.crm_agent_config set vision_enabled = true;`.
   This is last because it is the only step that grants the ability to read a
   private Storage object.
10. Enable `CRM_AGENT_TELEGRAM_DIGEST_ENABLED=true` on the scheduler. It also
    requires `TELEGRAM_LINKING_ENABLED=true`, because it answers on the same
    webhook.

## Verification

- One client with a recent enquiry has a `client_ai_state` row and exactly one
  open `client_ai_next_actions` row.
- A Gmail reply from a known client produces a row in
  `crm_private.gmail_client_ai_excerpts` and one `gmail:` job, and that
  relationship never holds more than five excerpts.
- Confirming a deposit through the normal payment flow produces a `project:`
  job, and the previously open `request_deposit` recommendation is superseded
  rather than left as the artist's next step.
- `get_client_ai_state` reports `is_stale: false` immediately after a refresh
  and `true` after the client replies.
- A recommendation whose `action_type` is `offer_dates`, `prepare_quote`,
  `request_deposit` or `confirm_booking` has `draft_reply IS NULL`.
- No `email_messages`, `communication_messages`, `sessions` or `payment_*` row
  was created by any of the above.
- `/needsme` in the artist's private Telegram chat lists their own open work and
  nothing belonging to another artist.

## Rollback

Set `CRM_AGENT_ENABLED=false`, or
`update crm_private.crm_agent_config set enabled = false;`. Both stop claiming
immediately and neither loses a row. Derived state is safe to delete outright:

```sql
delete from public.client_ai_next_actions;
delete from public.client_ai_state;
```

It rebuilds from CRM facts, which is the point of it being derived. Job rows
are safe to delete too. Do not delete `enquiry_file_ai_analysis` unless vision
is also being withdrawn, because re-deriving it costs a model call per image.

`crm_private.gmail_client_ai_excerpts` is the one store that does NOT rebuild:
its content comes from the mailbox, and the CRM only sees a message when the
Gmail Worker reads that thread. Deleting it loses recent context until the next
read, so withdraw it only when withdrawing Gmail ingestion itself.

Nothing here needs rolling back in an existing system: no existing table gained
a column, and no existing function changed behaviour.

## Cost

One `crm_client_state` call per client per batch of events, not per event: the
claim takes the newest queued refresh for a client and marks the backlog it
supersedes as stale. Prompt input is capped at roughly 11k characters, with the
timeline capped at 20 items and enquiries at 5. Vision is one call per uploaded
reference image, once, unless the object is replaced.

The canonical-fact triggers do not change that shape. A material project or
session change queues one job, a no-op UPDATE queues none, and several rapid
changes collapse at claim time. Reading the Telegram digest can queue a refresh
for a stale row, but keyed on the current watermark, so a digest read fifty
times in a minute queues one job.

## Deliberate omissions

- No Telegram buttons or callbacks. Every button worth adding is an action, and
  actions stay in the CRM where the artist is actually signed in.
- No external URL research bound to a client. Firecrawl works today through the
  GPT actions surface; associating its output with a client needs its own
  provenance and consent model.
- Private Storage objects never reach Firecrawl. The CRM path emits no URL at
  all, and `normalizePublicUrl` additionally rejects Supabase Storage URLs that
  arrive by another route.
