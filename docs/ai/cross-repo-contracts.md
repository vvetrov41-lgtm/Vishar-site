# Cross-repository ownership and contracts

Cross-repository traces must verify both sides of a contract at their own exact refs. Do not infer the consumer from the producer name or reuse a previous branch SHA without checking GitHub.

## Vishar-site ownership

Vishar-site owns the trusted CRM side of the booking and integration system:

- durable enquiry persistence;
- trusted booking-source resolution;
- artist ownership/routing;
- private file storage boundary;
- CRM roles and RLS;
- activity log;
- integration outbox;
- provider route metadata;
- provider credential selection on the backend;
- appointment system of record;
- Google Calendar projection/drain;
- agent/GPT appointment action boundary.

A public site may submit an enquiry to Vishar-site, but it must not decide authoritative artist/provider routing.

## `kisa` contract

Repository: `vvetrov41-lgtm/kisa` (default branch `main`; Cloudflare Workers
Builds deploys `main`). Resolve the current head before every investigation.

**Status: live since 2026-10-13.** kisa `main` at `d11440b8` (PRs #111 form,
#112 privacy notice), deployed by Cloudflare Workers Builds to the `kisa`
Worker that serves `kristinavishar.com` (version `d5b8e490`,
`CRM_PRIVACY_NOTICE_VERSION=2026-10-12`). CRM database released from
`cec763da`; TattooAI Worker and operator CRM released from `3884179d`.
The live probe reports
`enquiry-v2`.

The public form at `https://www.kristinavishar.com/booking/`:

- posts multipart to same-origin `/api/booking`;
- sends the enquiry-v2 shape (`formSchema=enquiry-v2`, `projectDetails` JSON,
  `designReferences`, `existingTattooPhotos`) with one body area and Kristina's
  styles; the page marks its form `data-form-schema="enquiry-v2"`;
- generates the idempotency key in the browser (UUID) and retries once with
  the same key and the same file bytes on network failure or 502/503/504.

The `kisa` Worker (`src/index.js`):

- accepts only same-origin POSTs, applies the honeypot and minimum fill time,
  rate-limits preflight;
- strips server-owned fields (`source`, `landingPage`, `artist_id`,
  `publicSourceId`, `sourceKey`, privacy fields, `idempotencyKey`) and sets
  them itself, including `privacyNoticeVersion` from `CRM_PRIVACY_NOTICE_VERSION`;
- forwards to `CRM_BOOKING_ENDPOINT`, the TattooAI Worker with the registry
  public source id in `?source=`, with the observed Origin;
- maps CRM 4xx to 400 and CRM 5xx or network failure to 502.

TattooAI resolves the source and Artist through `resolve_booking_source_public`
(public id plus exact Origin). The browser never selects routing.
`scripts/probe-kristina-live-booking-contract.mjs` checks this contract live
without persistence, in legacy or v2 mode as the page declares.

## Cross-repo trace procedure

For a request such as "trace Kristina booking to artist-specific integration":

1. Resolve the current `kisa` PR/branch/head SHA.
2. Verify the `kisa` checkout.
3. Locate `/api/booking` and `deliverToCrm` or their current equivalents.
4. Record the exact outbound endpoint, method, Origin behavior, multipart field names, idempotency behavior, and values that are deliberately absent.
5. Resolve the current Vishar-site PR/branch/head SHA containing the receiving intake implementation.
6. Verify that checkout independently.
7. Locate the receiving Worker route.
8. Verify exact Origin enforcement.
9. Verify booking source/form version come from trusted backend configuration rather than multipart fields.
10. Trace the database booking-source resolver to artist ownership.
11. Trace durable intake, file finalization, outbox creation, backend-only provider route resolution, and credential custody.
12. Compare the producer and consumer field contract. Report mismatches explicitly.

## Contract mismatch classes

Check for:

- endpoint/path mismatch;
- method/content-type mismatch;
- multipart field name mismatch;
- privacy notice/version mismatch;
- file count/size/type mismatch;
- idempotency format or retry mismatch;
- exact Origin mismatch;
- booking source/form version deployment mismatch;
- response/reference field mismatch;
- timeout/retry semantics that can create duplicate submissions;
- browser-controlled routing data accidentally added to the producer;
- consumer fallback that bypasses trusted routing.

## Other repositories

When another Vishar repository participates in a flow, add it only after inspecting the current implementation. Do not broaden this file with guessed ownership merely because repositories have related names.

The durable principle is simple: each repository documents what it owns, and agents prove the boundary on both exact revisions before claiming an end-to-end flow.