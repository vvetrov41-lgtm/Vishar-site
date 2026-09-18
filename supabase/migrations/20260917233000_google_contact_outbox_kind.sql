-- Google Contacts projection uses a dedicated durable outbox kind.
-- Keep this enum addition isolated from the migration that first uses the
-- value: PostgreSQL requires a commit boundary before a freshly-added enum
-- value is referenced by dependent objects in all supported deployment paths.

alter type public.outbox_kind
  add value if not exists 'google_contact_create';
