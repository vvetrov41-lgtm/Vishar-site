-- Keep raw AI job inputs behind the bounded service RPCs. The Worker has no
-- reason to read or mutate this table directly, and source_text may contain
-- private client email content.
revoke all on public.enquiry_ai_jobs from service_role;
alter table public.enquiry_ai_jobs force row level security;
