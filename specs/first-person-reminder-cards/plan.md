# Implementation and rollout

1. Fix artist-scoped Email reminder copy by adding the verified FAQ URL. Applied through existing production template configuration on 7 November 2026; the other artist's templates remain unchanged.
2. Add new provider contract names `vishar_lifecycle_reminder_72h_v2` and `vishar_lifecycle_reminder_24h_v2` in the WhatsApp template-maintenance Worker: first person, text header, FAQ URL button; preserve v1 byte-for-byte. Add synthetic unit tests.
3. Release the Worker through the protected exact-head release workflow. Do **not** change the production registry before verifying the Worker version.
4. After any previously pending production migration is deployed and the current migration head is read back, introduce an explicit protected database migration to select the new template names for Vladimir only. Do not switch Kristina.
5. The existing maintenance Worker must create v2 in Meta and record actual approval. Until then, the lifecycle runner must fail closed to the existing Email fallback. Do not mark templates APPROVED manually.
6. Once approved, verify a natural real reminder through the provider and CRM outbox. No direct sends to test clients.

## Safety
- Existing v1 registration and current pending jobs remain stable until the protected registry activation.
- Rollback before activation is a no-op. After activation, restore v1 through a new authorised migration and confirm its approval; never edit schema history in place.
- Do not bypass database/Worker release gates with direct production deploys.
- Existing confirmation URLs, booking tokens and consecutive-session dedupe remain in the existing backend.
