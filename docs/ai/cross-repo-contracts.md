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

Repository: `vvetrov41-lgtm/kisa`.

The CRM-first Kristina booking implementation is currently represented by draft PR #59, branch `agent/kristina-booking-crm-setup`. At the snapshot inspected on 2026-08-10 its exact head was `d14ae734e63fa2966eb288da05a5259776b2f035`.

That implementation:

- accepts only a same-origin POST at `/api/booking`;
- validates the public form and 1-3 reference images;
- sends the normalized multipart payload to an HTTPS `CRM_BOOKING_ENDPOINT`;
- generates an idempotency key server-side in the `kisa` Worker;
- forwards the observed site Origin to the CRM request;
- does not send an authoritative `artist_id`, booking source key, integration key, provider account, or payment destination;
- treats CRM save as the primary success boundary;
- treats its direct Telegram notification as optional/best-effort after CRM save.

This SHA is only historical context. Resolve the current PR #59 head before every future cross-repo investigation.

## Expected Kristina CRM-side binding

The current contract expects Vishar-site deployment configuration and database state to bind the request to Kristina through server-controlled values, including the logical booking source `kristina-website`, the deployed booking form version, and an exact allowed Origin.

Do not assume those values are active in production or staging. Check the target environment separately. The source contract and deployment activation are different facts.

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