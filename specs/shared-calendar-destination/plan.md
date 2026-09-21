# Implementation Plan

1. Extend Calendar route validation to accept a bounded non-empty server-owned Google calendar id.
2. Use that target for appointment and Time Off providers.
3. For non-primary targets, write/update the target first, then remove the same deterministic CRM event id from primary.
4. Prefer an optional server-owned destination event-label id over the primary-calendar label cached in the OAuth token.
5. Add a forward migration that preserves destination metadata across reconnects and configures Vladimir/Kristina for the shared studio calendar.
6. Deploy Worker first while production still says `primary`.
7. Apply the migration only after Worker readback.
8. Reproject Claudia as the canary, verify in Google Calendar, then reconcile remaining future projections.
