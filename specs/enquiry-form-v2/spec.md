# Booking form v2: adaptive multi-step tattoo enquiry

## Problem

The public `/booking/` form asks every visitor the same long list and allows
one project type. Real projects combine body areas (arm and leg), placements
(full sleeve over a forearm cover-up) and kinds of work (new, extension,
cover-up, rework). The CRM cannot tell a design reference from a photo of the
existing tattoo, and a WhatsApp-first client must still give an email.

## Required behaviour

1. One enquiry describes several body areas. Each area has its own
   placements and its own work types. One area never becomes a separate
   enquiry.
2. "No existing tattoo" excludes other work types for the same area. Sleeve
   lengths in one area are alternatives. Black & Grey and Colour may combine;
   "Not sure yet" is exclusive.
3. Images arrive in two roles: design references and existing-tattoo photos.
   Minimums, enforced in the browser and on the server:
   - new or extension work in any area: one design reference;
   - extension, cover-up or rework in any area: one existing-tattoo photo;
   - cover-up or rework inside a sleeve, full chest or full back: both.
   At most 4 per role and 6 in total, 4 MB each, 13 MB per request.
4. A WhatsApp-first client may omit email when the number is international
   (UK 07 mobiles are converted). Email-first clients may add WhatsApp as a
   backup, and the reverse.
5. The CRM shows the structured answers and labels images by role. The
   client's own idea text is stored verbatim. Legacy enquiries look as before.
6. Idempotency, honeypot, origin checks, privacy notice, consent-gated
   OpenAI/Meta handoff and conversion-after-save behave as for the legacy form.
7. A feature flag (`<meta name="vishar-enquiry-form">`) selects the form, with
   a `?enquiry_form=` override for verification. The legacy form stays in the
   page and remains the instant rollback.

## Non-goals

- No new business statuses or workflow changes.
- No new storage path layout or file category.
- Hosted booking forms keep their current single-step template.
