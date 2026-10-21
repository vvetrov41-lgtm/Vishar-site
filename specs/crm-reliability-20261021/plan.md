# Implementation and release plan

Repository vvetrov41-lgtm/Vishar-site. Canonical base agent/platform-telegram-self-service @ b8bd586b2a746c2a98b17e9904bb7ecfd4d27b14; main @ 4b3cf82e188181599495d06329cc4de15788fd4d is a different surface.

## Evidence and patch plan
Production migration head 20261020090000. service_record_attention_shadow is service-only and serializes an hourly aggregate, called by recordAttentionShadow in the scheduler. Logs 2026-10-20 07:10:20.661 and 07:15:22.979 UTC prove PostgreSQL statement_timeout / 57014 inside the report, with client_ai_watermark and client_timeline_items on the stack. They do not prove a lock wait. Authenticator statement_timeout and lock_timeout are both 8s. 75 nonarchived AI state clients.
Nonexecuting EXPLAIN VERBOSE of the live report body shows four client_attention call expressions after scope inlining; MATERIALIZED scope shows one. Read-only EXPLAIN ANALYZE of the two SELECT bodies: original 6191.402ms, materialized 2015.695ms (one sample each, no writes, 8s local ceiling). This is measured evidence, not a 24h stability claim.

## Design
PR-A: one additive migration replacing only attention_shadow_report, materializing scope; no change to caller, service gate, throttle, advisory lock, grants, report fields, intake or delivery. Add rollback-only pgTAP covering evaluation count and semantic invariance, plus unchanged permission boundaries. Preserve applied migrations.
PR-B: independent form browser automation and safe HTTP/file contract probes, staging regressions and real intake/Storage/outbox aggregates; do not publish a false pass if the runner is blocked.
PR-C: extend the existing Health Watch prompt/implementation after identifying its current ownership and schedule; threshold 3 same-RPC 500/hour, heartbeat >15m only if 5m cadence, new dead outbox warning, proved lost intake/wrong routing critical. Track idle pool closures separately.
PR-D only for proven audit findings; no bulk security/index changes from advisor counts.

## Validation and rollout
Run Node booking/scheduler tests, full pgTAP and lint in exact-head CI. Hosted staging currently at 0044: do not blindly apply hundreds of pending migrations or alter retained customer/test fixtures. Establish a safe staging migration path, validate the exact patch there, then existing exact-SHA database release gate. No direct production DDL through diagnostic tools. Production readback compares function body/ACL/migration head and bounded logs/health. Schedule 24h acceptance only after an actual deployment timestamp exists.

## Constitution/security
Server authority and tenant boundaries unchanged. RPC body replacement preserves function identity and privileges. Provider calls/credentials untouched. Only aggregated diagnostic data retained. New schema migration is independently reversible via a forward migration restoring the previous report body, never editing applied history.

## Risks
Materialization uses bounded intermediate memory for 75 current clients; full-suite schema/ACL tests and semantic parity guard behavior. One timing pair does not prove stability. Staging drift and blocked browser access are release blockers, not reasons to weaken gates.

## Analysis
Requirements map to separate bounded tasks. No unresolved blocking contradiction for PR-A code work; rollout is explicitly blocked on current staging validation. The user has authorized technical implementation and gated release; no new product choice is needed.
