begin;
select plan(2);

select ok(
  exists (
    select 1
    from public.enquiry_status_transitions
    where from_status = 'deposit_requested'
      and to_status = 'converted'
  ),
  'a deposit-requested enquiry can still be converted to a project'
);

select is(
  (
    select owner_only
    from public.enquiry_status_transitions
    where from_status = 'deposit_requested'
      and to_status = 'converted'
  ),
  false,
  'booking managers may use the deposit-requested conversion path'
);

select * from finish();
rollback;
