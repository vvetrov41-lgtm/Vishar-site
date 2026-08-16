# Kristina production booking recovery

## Target

- Repository source: the exact reviewed recovery head based on RC25
  `2729bf08ed206a0d6d42f6d055ded8489d0858e4`.
- Public producer: `kisa` Worker serving `https://www.kristinavishar.com`.
- Intake consumer: production `tattooai` Worker.
- Database: `vishar-crm-production`.
- Booking source: `kristina-website` owned by artist `kristina`.

## Observed production defect

The live `kisa` Worker requires CRM persistence before its optional Telegram
copy. Production still has `kristina-website` inactive with a null
`allowed_origin`, so the trusted CRM resolver cannot accept the form. The
public email address is a mailto fallback and is not a form-delivery backend.

## Change

1. Deploy the reviewed `tattooai` recovery source. Multipart intake derives
   `kristina-website` only from the exact canonical origin
   `https://www.kristinavishar.com`. Existing Vladimir production origins stay
   mapped to `vladimir-website`. Browser form fields cannot choose either.
2. Preserve the deployment-level exact `ALLOWED_ORIGINS` gate and add the
   canonical Kristina origin to it. Do not add wildcards or the apex origin.
3. Set the `kisa` Worker `CRM_BOOKING_ENDPOINT` variable to the exact production
   intake URL. Do not place Supabase or provider credentials in `kisa`.
4. In one transaction, set `booking_sources.allowed_origin` to
   `https://www.kristinavishar.com` and activate only `kristina-website` after
   the Worker preflight is green.

## Verification

1. Run Worker routing, booking-flow, bundle and committed-secret checks at the
   exact recovery head.
2. Submit one clearly labelled synthetic enquiry with one small synthetic PNG.
3. Verify the CRM enquiry is complete, artist-owned by Kristina, has one ready
   private file, and records `kristina-website` evidence.
4. Verify Kristina's Telegram route receives the post-persistence notification.
5. Verify a spoofed/lookalike origin and browser-supplied routing fields are
   rejected or ignored.

## Public impact and rollback

The form at `https://www.kristinavishar.com/#booking` begins saving to CRM and
then sending its optional Telegram copy. Roll back by disabling only the
`kristina-website` source, removing the `kisa` endpoint variable, and restoring
the previous `tattooai` Worker version. No enquiry or private image created by
a successful submission is deleted during rollback.
