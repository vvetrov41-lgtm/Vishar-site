-- 320_profile_language_localized_notifications.sql
--
-- Migration 20260928150000. System notification copy follows the recipient's
-- CRM language; English stays English; text a person or the model wrote is
-- not rewritten. Synthetic fixtures, rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege('authenticated', 'public.set_my_ui_language(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_my_ui_language(text)', 'EXECUTE'),
  'only a signed-in session can set its language'
);
select ok(
  has_function_privilege('service_role', 'public.service_telegram_chat_language(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_telegram_chat_language(text)', 'EXECUTE'),
  'chat language lookup is backend-only'
);
select ok(
  has_function_privilege('service_role', 'public.service_claim_telegram_notifications(text,integer,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_claim_telegram_notifications(text,integer,integer)', 'EXECUTE'),
  'the recreated Telegram claim keeps its backend-only ACL'
);

insert into auth.users (id, email) values
  ('f3200000-0000-4000-8000-000000000001', 'pl.ru@example.test'),
  ('f3200000-0000-4000-8000-000000000002', 'pl.en@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('f3200000-0000-4000-8000-000000000001', 'pl.ru@example.test', 'booking_manager', true),
  ('f3200000-0000-4000-8000-000000000002', 'pl.en@example.test', 'booking_manager', true);
insert into public.artists (id, slug, display_name, is_active) values
  ('f3201000-0000-4000-8000-00000000000a', 'pl-ru', 'Ru Artist', true),
  ('f3201000-0000-4000-8000-00000000000b', 'pl-en', 'En Artist', true);
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
   can_manage_sessions, can_manage_integrations, is_active)
values
  ('f3200000-0000-4000-8000-000000000001', 'f3201000-0000-4000-8000-00000000000a', 'manager', false, false, true, false, true),
  ('f3200000-0000-4000-8000-000000000002', 'f3201000-0000-4000-8000-00000000000b', 'artist', false, false, true, false, true);

-- The profile sets its own language; nobody else's.
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"f3200000-0000-4000-8000-000000000001"}', true);
set local role authenticated;
select is(public.set_my_ui_language('ru'), 'ru', 'a profile records Russian');
select is(public.set_my_ui_language('ru'), 'ru', 'setting the same language again is harmless');
select throws_ok($$select public.set_my_ui_language('de')$$, '22023', null, 'only en or ru are accepted');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select ui_language from public.profiles where id = 'f3200000-0000-4000-8000-000000000001'), 'ru',
  'the language is stored on the caller''s profile');
select is((select ui_language from public.profiles where id = 'f3200000-0000-4000-8000-000000000002'), 'en',
  'other profiles keep English by default');

select is(crm_private.artist_output_language('f3201000-0000-4000-8000-00000000000a'), 'ru',
  'an artist whose artist-facing profile reads Russian gets Russian AI notes');
select is(crm_private.artist_output_language('f3201000-0000-4000-8000-00000000000b'), 'en',
  'an English artist keeps English AI notes');

-- Producer templates, localised per recipient.
insert into public.notifications
  (id, recipient_profile_id, artist_id, notification_type, title, body, priority, status, dedupe_key, scheduled_at)
values
  ('f3202000-0000-4000-8000-000000000001', 'f3200000-0000-4000-8000-000000000001', 'f3201000-0000-4000-8000-00000000000a',
   'enquiry.created', 'New enquiry: Anna Client', 'AI summary:' || E'\n' || 'Wants a sleeve.', 'high', 'delivered', 'pl:1', now()),
  ('f3202000-0000-4000-8000-000000000002', 'f3200000-0000-4000-8000-000000000001', 'f3201000-0000-4000-8000-00000000000a',
   'client_ai.next_action', 'Needs you: Anna Client',
   'Suggested next step: request_deposit' || E'\n' || 'Клиент согласился на дату.' || E'\n'
     || 'This is a suggestion for your review. Nothing has been sent to the client.',
   'normal', 'pending', 'pl:2', now()),
  ('f3202000-0000-4000-8000-000000000003', 'f3200000-0000-4000-8000-000000000001', 'f3201000-0000-4000-8000-00000000000a',
   'system.ai_processing_failed', 'AI processing needs attention',
   '2 AI summaries could not be produced in the last 24 hours. The enquiries are saved; open them to review manually or retry AI.',
   'high', 'delivered', 'pl:3', now()),
  ('f3202000-0000-4000-8000-000000000004', 'f3200000-0000-4000-8000-000000000002', 'f3201000-0000-4000-8000-00000000000b',
   'enquiry.created', 'New enquiry: Ben Client', 'New enquiry received.', 'high', 'delivered', 'pl:4', now()),
  ('f3202000-0000-4000-8000-000000000005', 'f3200000-0000-4000-8000-000000000001', 'f3201000-0000-4000-8000-00000000000a',
   'follow_up.due', 'Call back about the design', 'Written by the artist.', 'normal', 'delivered', 'pl:5', now());

select is((select title from public.notifications where id = 'f3202000-0000-4000-8000-000000000001'),
  'Новая заявка: Anna Client', 'a new-enquiry title is Russian for a Russian recipient; the client name is kept');
select is((select body from public.notifications where id = 'f3202000-0000-4000-8000-000000000001'),
  'AI-сводка:' || E'\n' || 'Wants a sleeve.', 'the AI summary header is Russian and the summary text is untouched');
select is((select body from public.notifications where id = 'f3202000-0000-4000-8000-000000000002'),
  'Предлагаемый шаг: Запросить депозит' || E'\n' || 'Клиент согласился на дату.' || E'\n'
    || 'Это подсказка для вашей проверки. Клиенту ничего не отправлено.',
  'a next-action body shows a Russian step label and disclaimer around the model''s reason');
select is((select title from public.notifications where id = 'f3202000-0000-4000-8000-000000000002'),
  'Нужно ваше решение: Anna Client', 'a next-action title is Russian');
select ok((select body from public.notifications where id = 'f3202000-0000-4000-8000-000000000003')
  like 'За последние 24 часа не удалось подготовить AI-сводки: 2.%', 'a failure alert keeps its count in Russian');
select is((select title from public.notifications where id = 'f3202000-0000-4000-8000-000000000004'),
  'New enquiry: Ben Client', 'an English recipient keeps English');
select is((select title from public.notifications where id = 'f3202000-0000-4000-8000-000000000005'),
  'Call back about the design', 'text a person wrote is never rewritten');

-- The enrichment path updates title and body later; it is localised too.
update public.notifications
set title = 'New enquiry: Anna Client', body = 'AI summary:' || E'\n' || 'Хочет рукав.'
where id = 'f3202000-0000-4000-8000-000000000001';
select is((select body from public.notifications where id = 'f3202000-0000-4000-8000-000000000001'),
  'AI-сводка:' || E'\n' || 'Хочет рукав.', 'an enrichment update is localised as well');

-- Telegram chat language.
insert into crm_private.telegram_destinations(
  id, destination_kind, profile_id, chat_id, chat_type, safe_label, is_active, connected_by_profile_id
) values
  ('f3203000-0000-4000-8000-000000000001', 'profile', 'f3200000-0000-4000-8000-000000000001',
   '73200001', 'private', 'Telegram', true, 'f3200000-0000-4000-8000-000000000001');
insert into public.notification_preferences(profile_id, channel, is_enabled) values
  ('f3200000-0000-4000-8000-000000000001', 'telegram', true);
select is(public.service_telegram_chat_language('73200001'), 'ru', 'a linked chat answers in its profile''s language');
select is(public.service_telegram_chat_language('79999999'), 'en', 'an unknown chat answers English and reveals nothing');

select * from finish();
rollback;
