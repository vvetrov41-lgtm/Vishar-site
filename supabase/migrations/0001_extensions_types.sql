-- 0001_extensions_types.sql
--
-- Extensions, private helper schema, enums and the enquiry status transition
-- table for the Vishar Tattoo CRM.
--
-- Forward-only. Never edit this file once it has been applied; correct it with
-- a new, higher-numbered migration.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- Hosted Supabase already provides `extensions`; creating it here keeps the
-- migration runnable against a plain PostgreSQL cluster as well.
create schema if not exists extensions;

-- pgcrypto: gen_random_uuid() is in core from PostgreSQL 13, but pgcrypto is
-- still required for digest()/hmac() used by checksum verification.
create extension if not exists pgcrypto with schema extensions;

-- citext: case-insensitive staff email addresses on `profiles`.
create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- Private schema for internal helpers
--
-- Nothing in `crm_private` is exposed through PostgREST (see the `schemas`
-- list in supabase/config.toml). Public-facing RPCs live in `public`.
-- ---------------------------------------------------------------------------

create schema if not exists crm_private;
revoke all on schema crm_private from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.crm_role as enum ('owner', 'booking_manager', 'read_only');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.enquiry_status as enum (
    'new',
    'reviewing',
    'waiting_for_client',
    'accepted',
    'declined',
    'quote_sent',
    'deposit_requested',
    'deposit_paid',
    'converted',
    'closed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.enquiry_file_category as enum ('reference', 'design', 'session', 'healed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.enquiry_upload_state as enum ('pending', 'uploading', 'ready', 'failed');
exception when duplicate_object then null; end $$;

-- Intake lifecycle for the enquiry row itself. This is separate from
-- `enquiry_upload_state`, which tracks one file manifest at a time: an
-- enquiry is only `complete` once every required manifest is `ready`.
do $$ begin
  create type public.enquiry_intake_state as enum ('pending', 'files_pending', 'complete', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.project_status as enum ('draft', 'active', 'on_hold', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deposit_status as enum ('not_required', 'requested', 'paid', 'refunded', 'forfeited');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.session_status as enum ('draft', 'proposed', 'confirmed', 'completed', 'cancelled', 'no_show');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('unpaid', 'deposit_paid', 'part_paid', 'paid', 'refunded');
exception when duplicate_object then null; end $$;

-- `none` is the default: a session has no calendar projection until a
-- provider is actually connected. No provider is connected in this repository.
do $$ begin
  create type public.calendar_provider as enum ('none', 'google');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.outbox_kind as enum (
    'telegram_notification',
    'transactional_email',
    'approved_email',
    'calendar_create',
    'calendar_update',
    'calendar_cancel',
    'reconciliation'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.outbox_status as enum ('pending', 'leased', 'succeeded', 'failed', 'dead');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.email_message_status as enum ('draft', 'approved', 'queued', 'sent', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.follow_up_status as enum ('open', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Allowed enquiry status transitions
--
-- Transitions are data, not scattered application logic. `transition_enquiry_status`
-- (migration 0006) consults this table; arbitrary enum changes are refused.
-- ---------------------------------------------------------------------------

create table if not exists public.enquiry_status_transitions (
  from_status public.enquiry_status not null,
  to_status   public.enquiry_status not null,
  owner_only  boolean not null default false,
  note        text,
  primary key (from_status, to_status),
  constraint enquiry_status_transitions_not_self check (from_status <> to_status)
);

comment on table public.enquiry_status_transitions is
  'Allow-list of enquiry status changes. Rows marked owner_only may only be performed by the owner role.';

insert into public.enquiry_status_transitions (from_status, to_status, owner_only, note) values
  ('new',               'reviewing',         false, 'Picked up for review'),
  ('new',               'waiting_for_client', false, 'More information requested'),
  ('new',               'accepted',          false, 'Accepted straight away'),
  ('new',               'declined',          false, 'Not a fit'),
  ('new',               'closed',            false, 'Closed without action'),

  ('reviewing',         'waiting_for_client', false, 'More information requested'),
  ('reviewing',         'accepted',          false, 'Accepted'),
  ('reviewing',         'declined',          false, 'Not a fit'),
  ('reviewing',         'closed',            false, 'Closed without action'),

  ('waiting_for_client', 'reviewing',        false, 'Client replied'),
  ('waiting_for_client', 'accepted',         false, 'Accepted after clarification'),
  ('waiting_for_client', 'declined',         false, 'Not a fit'),
  ('waiting_for_client', 'closed',           false, 'No response'),

  ('accepted',          'quote_sent',        false, 'Estimate sent'),
  ('accepted',          'deposit_requested', false, 'Deposit requested'),
  ('accepted',          'waiting_for_client', false, 'Waiting on client decision'),
  ('accepted',          'converted',         false, 'Converted to a project'),
  ('accepted',          'closed',            false, 'Closed'),

  ('quote_sent',        'waiting_for_client', false, 'Waiting on client decision'),
  ('quote_sent',        'deposit_requested', false, 'Deposit requested'),
  ('quote_sent',        'accepted',          false, 'Terms agreed'),
  ('quote_sent',        'declined',          false, 'Client declined'),
  ('quote_sent',        'closed',            false, 'Closed'),

  ('deposit_requested', 'deposit_paid',      false, 'Deposit received'),
  ('deposit_requested', 'waiting_for_client', false, 'Waiting on payment'),
  ('deposit_requested', 'declined',          false, 'Client withdrew'),
  ('deposit_requested', 'closed',            false, 'Closed'),

  ('deposit_paid',      'converted',         false, 'Converted to a project'),
  ('deposit_paid',      'closed',            false, 'Closed'),

  ('converted',         'closed',            false, 'Project handled elsewhere'),

  -- Reopening a finished enquiry is an owner decision, never a manager one.
  ('declined',          'reviewing',         true,  'Owner reopened a declined enquiry'),
  ('declined',          'closed',            false, 'Closed'),
  ('closed',            'reviewing',         true,  'Owner reopened a closed enquiry')
on conflict (from_status, to_status) do nothing;
