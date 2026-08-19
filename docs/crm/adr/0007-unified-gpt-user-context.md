# ADR 0007: Unified GPT user identity and active artist context

Status: proposed, implemented in migration `0069`, not deployed.

## Decision

Vishar CRM will use one production Custom GPT and one confidential OAuth
application for every authorised CRM user. The OAuth `client_id` identifies the
Vishar GPT application. It no longer identifies an artist.

The authoritative action context is:

```text
Supabase OAuth access token
  -> auth.uid() active CRM profile
  -> active artist memberships
  -> server-owned active artist context
  -> per-artist GPT capability policy
  -> operation-specific CRM capability
  -> artist-scoped RPC
```

The three Action sets remain separate because the GPT Builder has a per-schema
operation limit:

- Core: 25 operations;
- Operations: 25 operations;
- Communications: 12 operations.

All three use the same OAuth application and therefore the same server-side
active artist context.

## Context storage

`crm_private.gpt_user_artist_contexts` stores one selected artist for the tuple
`(OAuth application, authenticated profile)`. Every action revalidates that
selection against the current active profile, active artist, active membership
and per-artist GPT policy. A revoked membership therefore invalidates a saved
selection immediately.

If the user has exactly one accessible artist, the resolver selects it
automatically without writing context. If the user has several and no valid
saved selection, operational actions fail with `active artist context is
required`. The GPT can then list safe artist keys and ask once.

The model may pass an artist key to `setActiveArtist`, but the key only names a
candidate. `crm_private.gpt_accessible_artist_policies(...)` performs the
authoritative membership check before the context row can change. No context
Action accepts an artist UUID, profile UUID, OAuth client ID, integration key or
provider identifier.

## Capability model

`crm_private.gpt_action_clients` becomes the per-artist GPT policy table. Its
existing capability flags remain authoritative. The legacy `oauth_client_id`
column remains temporarily for fixed-artist compatibility.

All action categories delegate to
`crm_private.require_gpt_identity_context(capability)`:

- appointment read/write;
- enquiry read;
- operational CRM;
- finance;
- communications.

The resolver first verifies membership, then checks the artist policy flag,
then calls the existing `require_artist_access` capability. Finance therefore
requires both the artist GPT finance policy and the human membership's
`manage_finance` permission.

## Provider isolation

Unified GPT means one application surface, not shared provider state.

- Gmail authorisation resolves the active artist for every request, then the
  Gmail service resolves that artist's enabled mailbox and artist-keyed token.
- Monzo reconciliation resolves the same active artist plus finance capability;
  raw provider identifiers remain excluded from GPT responses.
- WhatsApp and Calendar continue to resolve artist-owned integration routes.

Changing artist context cannot make an old provider thread, candidate,
conversation or appointment valid in the new context because each downstream
RPC rechecks the entity's artist.

## Transition

Migration `0069` is backward compatible:

1. Existing Vladimir and Kristina OAuth clients continue through
   `legacy_fixed` resolution.
2. The `vishar-unified-gpt` application is seeded disabled and without an OAuth
   client ID.
3. Production rollout later creates one confidential Supabase OAuth client,
   binds only its non-secret ID through `configure_gpt_oauth_application`, and
   enables it after migration and Worker verification.
4. The three schemas are imported into one GPT with the same OAuth credentials.
5. After user validation, the two old GPTs are contained first by disabling
   their legacy policy bindings. OAuth clients are revoked or deleted only in a
   separately approved cleanup.

Rollback keeps the old clients available. The unified application can be
disabled without changing artist policies, provider integrations or existing
OAuth clients.

## Deferred payment integration

This ADR does not expose the project deposit policy or reusable destination
management added in migrations `0067` and `0068`. Their final GPT operations
will be added separately. Existing Monzo reconciliation is adapted only because
it already calls the canonical finance context resolver.
