# Patch plan: finish Today cached Gmail metadata

Target: `agent/platform-telegram-self-service` at `de181914ed5ad46c8303709748881f314bff6284`.

Observed gap at target:

- Today no longer blocks first render on Gmail, but it still launches live Gmail discovery after render.
- Inbox still launches live Gmail discovery during its blocking loader.
- The client workspace does not yet load live Gmail history for the opened client.
- Complete Gmail discovery is metadata-only and bounded to five concurrent metadata fetches, but returns the result directly and writes no durable CRM snapshot.

Implementation sequence:

1. Add an artist/client-scoped Gmail metadata snapshot in Supabase with RLS/read boundary and backend-only refresh RPCs.
2. Change the Gmail Worker discovery path so scheduled/background refresh writes only known-client metadata to the snapshot; keep unknown senders out of CRM-facing state.
3. Add a scheduler/cron path with a bounded provider timeout and stale-snapshot fallback semantics.
4. Make Today and Inbox read the Supabase snapshot only; neither surface may call Gmail discovery while rendering.
5. Add client-detail on-demand Gmail history with a five-minute in-memory cache and explicit forced Refresh.
6. Preserve existing enquiry-scoped Gmail history/reply boundaries, WhatsApp/Instagram behavior, and provider credential custody.
7. Add/adjust Worker, CRM, migration/RLS and acceptance tests.
8. Run exact-head validation, re-check trunk for drift, merge only when safe, then use the protected release workflow and production readback.

Production acceptance:

- Today renders with zero Gmail provider requests.
- Gmail outage cannot block Today.
- Inbox list does not scan Gmail live.
- Opening one client loads only that client's Gmail content.
- Reopening within five minutes uses cache; Refresh bypasses it.
- A new inbound email from a known client still becomes attention metadata after background refresh.
- Unknown senders are not promoted into client work queues.
- WhatsApp and Instagram behavior is unchanged.
