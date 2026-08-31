# Plan

## Scope

This is a Calendar Worker-only behavior change plus a narrowly expanded Google OAuth read scope for resolving Kristina's existing Wisteria event label. No Supabase migration, no CRM UI change, no booking/Gmail/Telegram/WhatsApp/GPT deployment.

## Implementation

1. Extend trusted per-artist Calendar configuration with display name, visibility, legacy event color ID, and optional event-label target.
2. Keep `calendar_id = primary`, artist/provider account routing, integration keys, and token KV custody unchanged.
3. Project the trusted artist name into the event summary.
4. Apply Blueberry to Vladimir with legacy `colorId=9`.
5. Request `calendar.calendars.readonly` on future Calendar OAuth connections.
6. During successful OAuth callback, read only the authenticated primary calendar metadata and resolve Kristina's Wisteria label by exact configured name/color. Store only the resolved UUID inside the already encrypted per-artist KV token envelope.
7. Apply the stored label UUID as `eventLabelId` and add `eventLabelVersion=1` to Google insert/patch requests. Existing token envelopes without a label UUID remain compatible.
8. Extend regression tests for trusted artist naming, both-public visibility, Blueberry, Wisteria label resolution, query-version handling, invalid configuration, and backward-compatible tokens.

## Trust boundaries

- Browser/client payload cannot select artist display name, visibility, color, label, calendar, account, or credential.
- Database route still resolves artist integration/account and must match server configuration.
- OAuth actor authorization, exact Google account email check, encrypted KV custody, and narrow scopes remain authoritative.
- Calendar metadata scope is read-only; the Worker never mutates `labelProperties`.
- Supabase remains appointment authority; Google remains a projection.

## Rollout

Merge only after exact-head CI. Then use the existing exact-canonical-SHA Calendar backend production redeploy workflow, which rechecks production bindings/routes/cron/secrets before mutation and reads them back afterward. No database mutation is required.

Kristina must complete one Google Calendar reconnect after rollout so Google can grant the new read-only metadata scope and the Worker can resolve Wisteria. Until that reconnect, her events become public and artist-prefixed but retain their existing/default color rather than using an incorrect substitute.
