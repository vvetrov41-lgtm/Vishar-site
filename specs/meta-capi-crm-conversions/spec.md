# Meta CAPI / CRM conversions

## Goal

Add consent-gated, artist-scoped Meta Conversions API measurement for Vladimir without changing current campaign optimization away from Lead and without coupling Meta to OpenAI Ads.

## Production semantics

- Browser Pixel remains consent-gated.
- Successful website enquiry is `Lead`.
- Browser and server `Lead` use the same event id: the enquiry idempotency UUID.
- First transition to `accepted` emits custom event `QualifiedLead`.
- First real deposit-paid transition emits custom event `BookedClient`.
- Downstream events are emitted only for enquiries that granted Meta advertising measurement consent at intake.
- Failed/incomplete enquiry intake never emits `Lead`.
- No tattoo idea, reference image, medical/private note, message body or unrelated CRM content is sent to Meta.

## Attribution and privacy

Consent is explicit and separate from OpenAI Ads consent. When granted, retain only Meta measurement context required for matching/attribution: `_fbp`, `_fbc`, source URL and the original Lead event id. Email/phone remain authoritative CRM fields and are normalized + SHA-256 hashed in the backend worker immediately before provider delivery. Access token stays in backend secret storage only.

## Multi-artist boundary

Configuration is artist-scoped through `artist_integrations`. Vladimir is the only artist activated in this rollout. Kristina and other artists must not inherit Vladimir's Dataset/Pixel or secret.

## Reliability

All server events use the existing durable integration outbox with deterministic dedupe keys, leases, bounded exponential retry and dead-letter state. Provider failure must not invalidate an enquiry, status transition, project, deposit or unrelated integration.

## Meta configuration

Vladimir Dataset/Pixel: `1729215778134902` (`Vishar Tattoo Web`). Graph API version: `v26.0`. Campaign optimization remains `Lead` initially.
