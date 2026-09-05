# Implementation Plan: Enquiry discovery attribution

## Target

- Canonical CRM base at planning preflight: `agent/platform-telegram-self-service` @ `8c3e21b155cb1baec9b319e17f5879ea6d5aece9`.
- Bounded branch: `agent/enquiry-discovery-source`.
- Re-check canonical and branch ancestry immediately before merge and production mutation.

## Architecture

### Data

Add forward-only migration `0140_enquiry_discovery_source.sql`.

- Add nullable `public.enquiries.discovery_source text`.
- Add a database CHECK allowing NULL or: `instagram`, `chatgpt`, `other_ai`, `friend_referral`, `google`, `other`.
- Do not backfill historical rows.
- Reuse the existing table-level SELECT grant and RLS on `enquiries`.
- Extend `crm_private.create_enquiry_for_booking_source(...)`, the common transactional wrapper used by hosted and trusted source intake, so the validated discovery value is stored in the same transaction after `create_enquiry_intake` returns and while source ownership is verified. This avoids duplicating the large legacy core intake function while preserving one authoritative booking-source path.
- Verify replay equality. The existing core fingerprint includes all of `p_enquiry`, so a replay with a different discovery value remains an idempotency mismatch rather than silently changing attribution.

### Worker/public booking

- Add a bounded optional `discoverySource` parser with an explicit allow-list. Missing/empty stays NULL for legacy/external compatibility; unsupported non-empty values fail validation.
- Pass the stable value as `p_enquiry.discovery_source`.
- Add a required `<select name="discoverySource">` to the shared canonical `/book/{artist}` HTML. Because Vladimir, Kristina, and Sam all use this renderer, all three receive the field together.
- Include the field in the browser FormData copy list.
- Do not alter source/artist routing fields or trust boundaries.

### CRM Statistics

- Extend the statistics enquiry projection/type with `discovery_source`.
- Add a dedicated pure aggregation for self-reported discovery values. Do not reuse or change `sourceBreakdown`, which remains technical acquisition attribution.
- Add a separate Statistics section with localized labels and a not-recorded bucket.
- Keep period and artist filters identical to the existing enquiry statistics dataset.

### Operator parity

This change adds no new mutation or operator action. It extends an existing read-only Statistics view with another aggregate over already-authorized enquiry rows. Parity classification: `available` through existing bounded enquiry/statistics read semantics; no new GPT/MCP operation is required and no generic query surface will be introduced.

## Tests

- Worker validation: accepted stable values, omitted value, unsupported value.
- Public booking page: required selector and all six options; existing routing-forgery tests stay green.
- pgTAP: column/check constraint, NULL compatibility, hosted/trusted persistence, invalid value rejection, idempotent replay behavior if fixture coverage permits.
- Statistics pure tests: category counts/shares, NULL bucket, stable ordering/tie behavior.
- Statistics API/page tests: projection includes the field and the separate localized section renders without changing the technical-source section.
- Existing full CRM and booking validation suites must stay green.

## Rollout

Code completion and production rollout are separate gates.

1. Exact-head PR CI on the bounded branch.
2. Fresh-check canonical/base drift and mergeability; merge only from the proven head.
3. Verify new canonical post-merge CI.
4. Fresh-check production Supabase migration head and Cloudflare/Pages state.
5. Apply migration 0140 with existing guarded production migration automation.
6. Deploy the TattooAI/public booking Worker from the exact canonical release lineage.
7. Deploy CRM Pages from the same canonical lineage.
8. Read back production migration head and deployed revisions.
9. Read-only acceptance: `/book/vladimir`, `/book/kristina`, `/book/sam` contain the field/options; unknown slug and forged routing remain safe; CRM bundle/page contains the new statistics UI. Do not create fake enquiries.

## Rollback/recovery

- Database migration is forward-only; the nullable column is backward compatible and harmless to older Worker/CRM builds.
- If Worker rollout fails after DB migration, keep the DB change and restore/redeploy the last known-good Worker; legacy forms omit the field safely.
- If CRM Pages rollout fails, data collection can continue and the prior Statistics UI simply does not display the new dimension yet.
- Never remove or rewrite historical attribution during rollback.