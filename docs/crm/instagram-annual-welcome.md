# Annual Instagram auto-welcome

The account switches in `crm_private.instagram_welcome_controls` start OFF.
This feature uses the existing Instagram webhook, Worker, token store and
`integration_outbox`. No separate queue or Worker is introduced.

## Identity and policy

History is keyed by artist UUID + Instagram business account ID + sender IGSID,
not username, integration row ID or connection timestamp. Keep this registry
when archiving/deleting conversations or reconnecting accounts. A changed business
account is a separate identity; app/IGSID migrations require an explicit mapping.

Received contact messages are transactionally deduplicated by the existing inbound
RPC. An AFTER INSERT trigger checks the switch and reserves a registry row with
`INSERT ON CONFLICT` and `FOR UPDATE`. The same transaction writes one automation
message and one existing outbox job with `max_attempts=1`. No old history is imported.
Messages predating activation or older than 23 hours are ineligible. This preserves
a buffer before Meta's 24-hour standard response window.

On confirmed success, the next eligible time is the London local send time plus
`interval '12 months'`, converted back to timestamptz. February 29 clamps to February
28. A new inbound after that boundary is required; no anniversary message is sent
without an incoming message. The result timestamp may conservatively follow actual
acceptance by a small amount because Postgres records the ACK.

The send intent checks the switch, allowlist, current route/account, suppression,
window and reservation again. Durable sending state cannot be reclaimed on lease
expiry. Network exceptions, ambiguous 5xx/redirect/408 or malformed success map to
`communication_send_result_unknown`; the job is terminal and the contact remains
blocked indefinitely. A crash after provider acceptance also leaves the send intent
and registry blocking a second send. Do not clear this evidence on reconnect.

Confirmed 4xx refusal is terminal for this inbound event; a later new inbound may
try again because Meta definitely refused the first request. No background retry.
An unresolved reservation can miss a welcome; do not trade duplicate prevention
for coverage by automatically expiring reservations.

## Controls and cutover

Backend-only RPC `service_set_instagram_welcome_mode(artist_id, account_id, mode,
test_contacts, meta_instant_reply_disabled)` supports `off`, `test`, `live`.
`test` requires 1-20 explicitly agreed IGSIDs. Both active modes require confirmed
Meta Instant Reply disablement and a current connected account. No browser RPC
or endpoint exposes this control. Disabling does not modify history.

1. Deploy additive database migration and uncertainty fix through existing protected
   exact-SHA release paths. Keep both modes off. Read back controls, ACLs, migration
   head, active Worker version and zero welcome jobs. No staging.
2. Obtain user confirmation before changing active Meta rules or enabling real sends.
   Resolve separately agreed test contacts; never use a client as a test fixture.
3. In Meta Business Suite inspect each artist, preserve source text, disable only
   Instagram Instant Reply. Do not change Messenger Away Message. Verify the switch
   is off before asserting `meta_instant_reply_disabled=true`.
4. Enable Vladimir in test mode for the agreed IGSID. The tester sends a DM. Verify
   exactly one received welcome, provider message ID and registry ACK. A second DM,
   duplicate event and reconnect must not resend. Never modify production dates to
   simulate the anniversary; use the local/CI fixture suite.
5. Enable Vladimir live after successful acceptance, then repeat Kristina's test and
   activation. Verify exact body, with only her booking and FAQ links differing.
6. Rollback: set mode off, preserving registry and unknown outcomes. Already-started
   provider calls may complete. Never re-enable the repeating Meta rule automatically.

If a provider outcome is unknown, inspect actual conversation/provider evidence.
Only authoritative evidence of a rejection may unblock an unknown contact. Text
similarity or absence of an echo is not proof. No automatic recovery RPC resets it.

## Pending acceptance

Test contacts and activation approval are intentionally unresolved until requested
after all autonomous preparation and production readback have completed.
