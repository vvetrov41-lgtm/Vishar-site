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

## Fixed runtime boundary

- Migrations: `20260910160000_crm_agent_client_ai.sql`,
  `20260910170000_crm_agent_telegram_digest.sql`,
  `20260910180000_crm_agent_gmail_hook.sql`.
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
2. Apply the three migrations. They create four tables, add triggers to
   `enquiries`, `communication_messages`, `communication_conversations`,
   `enquiry_files` and `crm_private.gmail_thread_contexts`, and add no column to
   any existing table. Every trigger is AFTER and wrapped, and every scheduler
   short-circuits while `crm_agent_config.enabled` is false, so applying the
   migrations changes no existing behaviour.
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

Nothing here needs rolling back in an existing system: no existing table gained
a column, and no existing function changed behaviour.

## Cost

One `crm_client_state` call per client per batch of events, not per event: the
claim takes the newest queued refresh for a client and marks the backlog it
supersedes as stale. Prompt input is capped at roughly 11k characters, with the
timeline capped at 20 items and enquiries at 5. Vision is one call per uploaded
reference image, once, unless the object is replaced.

## Deliberate omissions

- No Telegram buttons or callbacks. Every button worth adding is an action, and
  actions stay in the CRM where the artist is actually signed in.
- No external URL research bound to a client. Firecrawl works today through the
  GPT actions surface; associating its output with a client needs its own
  provenance and consent model.
- Private Storage objects never reach Firecrawl. The CRM path emits no URL at
  all, and `normalizePublicUrl` additionally rejects Supabase Storage URLs that
  arrive by another route.
