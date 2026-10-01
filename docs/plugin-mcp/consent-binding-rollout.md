# Dedicated Plugin consent binding

The registered Supabase public OAuth client alone does not pass CRM consent.
CRM also requires an active `crm_private.gpt_action_clients` profile binding.
This was absent at the production readback on 2026-10-01.

## Bounded correction

Extend the existing exact-SHA activation workflow, not the MCP runtime or ACLs.
The operator checks the reviewed public client, exact callback, grants and
existing legacy capability ceilings before mutation. After edge readback and
a fresh canonical/trigger check, one transaction creates only
`vishar-crm-plugin` with `binding_mode=profile`, no fixed Artist, and the
existing enabled legacy capability ceilings. Every request still checks the
human profile, workspace, membership, selected Artist and capability.

Automations, integration administration and workspace administration ceilings
stay **false**, matching current production legacy clients. Their discovery
contracts remain present, but activation is not claimed. The Cloudflare
gateway stays read-only and its existing human permissions remain enforced.

No schema migration, OAuth secret, customer record or legacy client is changed.
Different existing Plugin configuration or changed legacy state aborts rather
than overwriting. The transaction writes a safe system audit event once.
Retries with the exact desired state are no-ops. Rollback is a separately
authorized deactivation of this dedicated binding, preserving the audit event.

## Validation and acceptance

Run `node scripts/test-mcp-plugin-client-activation.mjs`, existing MCP contracts,
bundle validation and exact-head CI. Release through the existing marker-only
production activation ref after fresh lineage, DB drift and Cloudflare checks.
Read back the dedicated row and prove the legacy fingerprint is unchanged.
Human OAuth consent and signed-in tool acceptance remain separate steps.
Do not claim authenticated acceptance from a privileged configuration read.

This fixes existing OAuth UI-only connection parity, not a new model tool.
The five owner exclusions and two Stage 2 invitations remain excluded.
