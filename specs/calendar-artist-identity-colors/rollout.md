# Rollout boundary

Production mutation is restricted to `vishar-calendar-production`. The release must not deploy CRM Pages, apply Supabase migrations, change Cloudflare routes, or touch Gmail, Telegram, WhatsApp, Instagram, GPT, booking, Monzo, or Team admin workers.

The existing Calendar backend production redeploy workflow is the release path because it validates the exact canonical SHA, re-runs Calendar tests, reads live Cloudflare state before mutation, deploys only the Calendar Worker, and reads the deployment/bindings/routes/cron state back afterward.
