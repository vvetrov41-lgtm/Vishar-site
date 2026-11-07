# First-person tattoo reminder cards

## Problem
A WhatsApp 72-hour Utility template sent to Simon Bridgman on 7 November 2026 was provider-delivered and read but used third-person wording ("with Vladimir") and a plain body-only template. The intended experience is a structured reminder from the artist, with a preparation-guide link. Existing booking confirmation cards do not automatically substitute for lifecycle reminders.

## Requirements
- Future 72-hour and 24-hour tattoo reminders from Vladimir use first-person language.
- WhatsApp reminders render an approved Utility template with a titled header and a working "How to prepare" button that links to https://vishartattoo.com/faq/.
- Preserve date-grouping, one reminder per consecutive-day block, separate deposit cancellation windows, exact session times, and 24-hour confirmation URL.
- Preserve existing v1 Meta templates and provider delivery history. Never change the content of an approved v1 template under its name.
- Meta approval must be observed for each new template before any CRM lifecycle job may select it.
- When a new WhatsApp template is unavailable, use existing one-time Email fallback rather than silent drop or unsafe unapproved send.
- No real client test sends, duplicate reminders, or synthetic production bookings.
- Client Email reminders at 72 and 24 hours contain the same preparation FAQ URL and first-person text.

## Acceptance
- Provider v2 template is approved as Utility, with correct body-variable count, header and button.
- A future real WhatsApp reminder has a delivery/read status, includes the FAQ button and is phrased from the artist.
- Same-day consecutive sessions do not create duplicate reminder messages.
- The 24-hour message retains secure booking confirmation functionality.
- Production SQL migration lineage, Worker deployment SHA and provider readback are confirmed.
