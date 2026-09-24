# CRM AI architecture: deterministic core, narrow AI

Source audit: `docs/audits/2026-09-24-crm-ai-opus55-architecture-audit.md`
(merged in PR #869, trunk `8fc0862`).

## Problem

Production evidence on 2026-09-24:

- 76% of client briefs come from the Llama 3.1 8B fallback, silently.
- Router attempt data is discarded, so the cause of each fallback is unknown.
- The model owns `stage` and `waiting_on`, and gets them wrong against CRM facts.
- 26 unmatched WhatsApp conversations never reach client intelligence.
- Leads go cold without any event, and nothing notices.
- CRM Today and Telegram `/today` answer the same question from two engines.

## Required behaviour

1. Every AI run is observable per attempt, with no private content stored.
2. Model routes are chosen from measured quality, validity, latency, failure
   and cost. Provider share is a diagnostic only.
3. Workflow facts (last speaker, stage, SLA, conflicts, allowed actions) are
   deterministic. Whether a message needs a reply is semantic and separate.
4. AI does semantic work only: summary, stated facts, open questions,
   promises, reply need, and one action chosen from the allowed set.
5. One server-side Pulse feeds CRM Today and Telegram `/today`.
6. Unmatched inbound appears in attention before it is linked.
7. Stated facts carry provenance; conflicts are surfaced, never resolved
   silently.

## Out of scope

General tool-using agent, multi-agent orchestration, vector search, numeric
lead scores, autonomous prices/dates/bookings/payments, and any new
client-facing autonomous send path.

## Acceptance

See section P of the audit. Each phase is complete only after production
readback proves it.
