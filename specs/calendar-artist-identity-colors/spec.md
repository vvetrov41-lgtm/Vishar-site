# Calendar artist identity and colors

## Goal

CRM appointment projections must be immediately understandable to the studio without per-event privacy, naming, or color edits.

## Required behavior

- Vladimir appointment events use `public` visibility.
- Kristina appointment events use `public` visibility.
- The event summary starts with the authoritative artist display name, then appointment type and client name.
- Vladimir events use Google Calendar Blueberry.
- Kristina events use Google Calendar Wisteria.
- Artist identity and provider styling are resolved from server-controlled artist configuration, never browser input or appointment payload fields.
- Existing Calendar account routing, token custody, outbox leasing, stale-result handling, and Supabase appointment authority remain unchanged.

## Google label constraint

Blueberry is supported by the legacy event color palette as color ID `9`. Wisteria is not a legacy event color. Google Calendar's current API exposes Wisteria through per-calendar event labels (`eventLabelId`). The connector may request read-only calendar-metadata scope solely to resolve the existing Wisteria label on the authenticated artist calendar; it must not create, rename, delete, or otherwise mutate calendar labels.

Existing refresh tokens that predate the metadata scope remain usable for ordinary appointment delivery. Kristina's exact Wisteria styling becomes active after her Calendar OAuth connection is renewed and a matching Wisteria label is resolved. Missing or ambiguous label metadata must never be guessed as another purple color.

## Failure behavior

- Invalid configured visibility or legacy color ID fails before a Google event request.
- An invalid stored label ID is ignored as unavailable styling rather than redirected to another label.
- OAuth label lookup must fail closed if a reconnect explicitly requires Wisteria but Google cannot return exactly one matching label by name or expected color.
- No provider credentials, refresh tokens, access tokens, or label catalogs enter Supabase or browser-visible responses.

## Acceptance criteria

1. Unit coverage proves both artists are public and artist names come from trusted configuration.
2. Vladimir projection contains legacy color ID `9`.
3. Kristina projection uses `eventLabelId` plus `eventLabelVersion=1` when her renewed token contains the resolved Wisteria label ID.
4. Existing Kristina tokens without a stored Wisteria label continue delivering events without a false color until reconnect.
5. Exact-head CI is green.
6. Only the Calendar production Worker is redeployed.
7. Production readback proves Calendar runtime boundaries remain intact.
8. After Kristina reconnects, a non-destructive provider readback or legitimate subsequent CRM event confirms `public`, artist-prefixed title, and Wisteria styling.
