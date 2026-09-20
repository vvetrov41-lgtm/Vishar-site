-- Google Contacts reconciliation is invoked in the same service-role RPC that
-- flips google_contacts_sync from false to true. A STABLE helper can retain the
-- caller statement snapshot and therefore miss that preceding UPDATE.
--
-- VOLATILE is required here so the capability check sees writes performed
-- earlier in the same RPC before reconciliation queues existing linked clients.

alter function crm_private.google_contacts_sync_enabled(uuid)
  volatile;

comment on function crm_private.google_contacts_sync_enabled(uuid) is
  'Private fail-closed Google Contacts capability check. VOLATILE so same-RPC enablement is visible before reconciliation.';
