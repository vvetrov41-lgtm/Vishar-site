# Enquiry reply evidence

## Problem

On 2026-10-04 Today showed `enquiries_without_reply_30d = 23` and
`median_first_reply_hours = 236.8` for Vladimir. Most of those clients had
been answered: in Gmail directly (Samuel Moore, Gabriel Lyse Hackman, Vlad,
Fran Preston, Ashlee Bald and others) or in the WhatsApp phone app before the
CRM ingested phone-app echoes (Lewis Jacobs, Joe Marsh, Simon Jeanes).

`crm_private.pulse_summary` only read `communication_messages` and CRM-sent
`email_messages`. It ignored Gmail evidence, counted failed/queued/automated
outbound messages as replies, and took the first message the CRM happened to
see as the first reply.

## Definition

An enquiry is answered when, after it was created and before the same
client's next enquiry to the same artist, there is:

1. a WhatsApp/Instagram message a person wrote (origin `crm`/`provider_app`)
   that the provider accepted (`sent`, `delivered`, `read`);
2. a CRM email with status `sent`, `sent_at` and a provider message id, not
   system/automation mail;
3. a Gmail SENT message from the artist mailbox to the client; or
4. an operator attestation for a reply the CRM could not see: the operator
   cleared the client's Today reply item or the enquiry's item, moved the
   enquiry to `waiting_for_client`, or booked an appointment.

Not a reply: drafts, `approved`, `queued`, `failed`, `cancelled`, AI drafts,
automation messages, internal notes, status alone, messages before the
enquiry, messages after the client's next enquiry.

First reply time = earliest provider-confirmed message in the window, unless
an attestation predates it (then the real first reply was unseen and the time
is unknown). Attested-only enquiries are answered but never enter the median.

## Acceptance

- One canonical predicate (`crm_private.enquiry_reply_state`) feeds the
  summary, the Today `new_enquiry` item and the Telegram enquiry reminder.
- pgTAP `323_canonical_enquiry_reply_evidence.sql` covers every case above.
- Production readback: the named clients are not counted; the remaining
  count and median are shown with the enquiries behind them.
