-- 0117_deposit_not_requested_status.sql
--
-- Distinguish a deposit that has not been requested yet from an explicit
-- business decision that no deposit is required. Keep this enum addition in a
-- separate migration because PostgreSQL requires a newly added enum value to
-- be committed before later statements use it.

alter type public.deposit_status
  add value if not exists 'not_requested' before 'not_required';

comment on type public.deposit_status is
  'Project deposit lifecycle. not_requested means no request has been created yet; not_required is an explicit waiver.';
