-- 0118_enquiry_deposit_conversion.sql
--
-- A requested deposit belongs to the project/payment-ledger lifecycle. The
-- enquiry must therefore remain convertible after the operator records that a
-- deposit has been requested; otherwise `deposit_paid` requires a project that
-- the UI/database no longer allow the operator to create.

insert into public.enquiry_status_transitions (
  from_status,
  to_status,
  owner_only,
  note
)
values (
  'deposit_requested',
  'converted',
  false,
  'Create the project before recording a settled deposit payment.'
)
on conflict (from_status, to_status) do update
set owner_only = excluded.owner_only,
    note = excluded.note;
