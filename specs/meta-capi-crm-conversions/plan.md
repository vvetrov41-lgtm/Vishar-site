# Plan

1. Extend integration/outbox enums for Meta.
2. Add private Meta attribution storage, Vladimir artist integration metadata, deterministic enqueue helpers, lifecycle triggers, claim/ack RPCs and indexes.
3. Add Worker Meta CAPI client and durable drain using Graph API v26.0, backend-only token and bounded retry.
4. Add Meta drain as an independent scheduled task in the existing production scheduler.
5. Extend enquiry intake to persist Meta attribution only after explicit Meta advertising consent, without making Meta a booking dependency.
6. Port/preserve current production browser Pixel/OpenAI consent behavior and submit `_fbp`/`_fbc`/source URL only when Meta consent is granted.
7. Update privacy notice wording and remove avoidable privacy-version drift.
8. Add unit/database tests for consent, idempotency, retries, artist isolation, credential boundaries, event semantics and OpenAI independence.
9. Validate on a production-derived Supabase branch or an otherwise schema-current staging environment before production migration/deploy.
10. Activate only Vladimir after Meta backend credential is configured, then verify browser/server Lead dedup and downstream test events.
