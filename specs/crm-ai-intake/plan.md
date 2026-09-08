# Implementation Plan: CRM AI intake

## Verified baseline
Latest fresh-check during implementation: CRM trunk d8ff3373fbd37867ed52081ddb16d87bf34b678d; later changes are isolated booking-panel work and do not overlap this workstream. Production DB vfjexhfdbrjmuxfdvbdx migration 20260908004000; staging only 0044 (cannot assume parity). Existing intake uses workspace identity advisory locks; existing email_messages trigger restricts AI to drafts. Qwen/router production probe succeeded; OpenAI is not required.

## Design
Add scoped durable AI jobs with unique source identity, deny direct browser table access, service-only claim/finish/failure RPCs and authenticated ownership-checked read/retry. Queue completed enquiries; no model-selected IDs. Snapshot full scoped context at claim; lock and compare at finish. Store extracted values as suggestions, not replacements of trusted human fields. Atomically create one existing email_messages draft, preserving reply editing/sending gates.

Use existing tattooai binding/router with bounded Qwen-first structured task; strict application schema plus independent database shape/ownership checks. No tools in prompts. Reuse background execution and a bounded recoverable drain; enable through server configuration. Existing Gmail path supplies trusted artist and original message identity. An atomic observation establishes a baseline for an old thread and queues only a later changed, relevant inbound message, avoiding historical backfill and duplicate mailbox architecture.

Reuse enquiry page patterns for scoped result state and draft. Classify operator parity explicitly; do not add broad RPC/GPT execution.

## Safety and validation
Positive and denial pgTAP tests against full current migrations; behavioral Node tests including injected output and model failures; CRM typecheck/build. CI validates immutable head. Keep image bytes out of AI path. Privacy text must describe actual text processing before activation. Rollback disables claim/execution, leaving original intake intact.

## Release
Recheck canonical before publish/merge, exact-head CI, production migration dry-run, existing protected exact-SHA Worker and CRM release workflows, readback, safe service probes and authorized legitimate enquiry acceptance. No synthetic customer rows in production.
