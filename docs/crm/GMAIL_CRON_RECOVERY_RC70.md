# Gmail cron recovery rc70

Operator-only recovery record for the Gmail production send activation.

- Product head: `9677ee0edb0e70ce8376d684efcb002569aa53c8`
- Previous send activation uploaded the Worker with Gmail OAuth/read/drain flags enabled, then failed while applying the Cloudflare Cron Trigger.
- This recovery workflow reads only the five safe Gmail feature flags and the Worker schedule API state, then installs exactly `*/5 * * * *` if missing.
- It does not deploy Worker code, rotate secrets, modify Supabase, touch Calendar, staging, Telegram, WhatsApp, or Monzo.
- Cloudflare API responses are reduced to HTTP status plus bounded error code/message on failure.
