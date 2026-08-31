# Acceptance

Production acceptance is intentionally split into two phases.

1. Worker rollout acceptance: exact-head CI, Calendar-only deploy, Cloudflare binding/route/cron readback, no database mutation.
2. Wisteria activation acceptance: Kristina renews her Google Calendar OAuth grant once, after which the encrypted token envelope contains the resolved Wisteria event-label UUID. A legitimate subsequent CRM appointment/readback must show public visibility, `Kristina` first in the title, and Wisteria styling.

Vladimir requires no reconnect for Blueberry because legacy event color ID 9 already maps exactly to Blueberry.
