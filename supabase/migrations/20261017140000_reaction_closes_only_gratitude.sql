-- A studio reaction closes a client message only when the message is plainly
-- a thank-you or a goodbye.
--
-- 20261017090000 let a reaction close any inbound without a question mark.
-- A request does not need one: "I'd like to book Saturday. Please let me
-- know if that's possible." followed by a heart was treated as answered, and
-- when the classifier had not marked it (down, failed, unsure or simply not
-- run yet) nothing kept it open.
--
-- The rule is now positive evidence only. A reaction acknowledges the inbound
-- when crm_private.is_closing_message() recognises it (gratitude, a goodbye,
-- kisses or affectionate emoji, and nothing else), or when the classifier or
-- an operator marked that exact message no_reply_needed: the reaction and the
-- mark are two independent signals that agree. Anything else (a request, an
-- agreement such as "ok" or "perfect", a date, a thumbs-up, an attachment
-- without text) stays in "reply" until a person answers it or dismisses it.
-- A classifier that is down, failed or unsure leaves no mark, so it can only
-- keep a message open. A reply_required mark still keeps any message open.
--
-- Only studio_reaction_acknowledged_at changes. attention_comm_facts,
-- pulse_attention_batch and conversation_awaiting_reply_since already call it,
-- so Today, Telegram /today and the batch stay in parity. The replaced
-- definition is checked against production on 2026-10-17 and the migration
-- fails closed on drift.

do $guard$
declare
  v_actual text;
begin
  select md5(p.prosrc) into v_actual
  from pg_proc p where p.oid = 'crm_private.studio_reaction_acknowledged_at(uuid)'::regprocedure;
  if v_actual is distinct from 'ed302e5acf8aec32e0c9c377ee81ab1e' then
    raise exception 'reaction rule: studio_reaction_acknowledged_at drifted since the 2026-10-17 baseline (md5 %)', v_actual;
  end if;
end
$guard$;

-- True only for a short message that says thanks or goodbye and nothing more.
-- Every word must come from the closing vocabulary, at least one of them must
-- be gratitude, a goodbye or kisses (a message without words needs an
-- affectionate emoji; bare punctuation is not a goodbye), and anything left after the words, spaces and
-- punctuation must be an affectionate emoji. A question mark is never
-- removed, so a question never qualifies. Agreement words (ok, yes, sure,
-- great, perfect, lovely, sounds good, хорошо, договорились) are left out on
-- purpose: after an offer they are a choice the studio still has to act on.
create function crm_private.is_closing_message(p_body text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  with norm as (
    select lower(btrim(p_body)) as t
  ),
  -- "have a nice day" and the like: the adjectives are not allowed alone.
  phrased as (
    select regexp_replace(t,
      '\mhave an? (very )?(nice|good|great|lovely|wonderful|amazing) (day|evening|weekend|week|night|one)\M',
      ' thanks ', 'g') as t
    from norm
  ),
  words as (
    select coalesce(array_agg(m[1]), '{}') as w
    from phrased, regexp_matches(phrased.t, '([a-zà-öø-ÿāăąćčďęěğıłńňőřśşšţťůűźżžșțа-яёіїєґ]+)', 'g') m
  ),
  rest as (
    select btrim(regexp_replace(regexp_replace(phrased.t,
      '[a-zà-öø-ÿāăąćčďęěğıłńňőřśşšţťůűźżžșțа-яёіїєґ]+', '', 'g'),
      -- spaces, sentence punctuation, and affectionate emoji with their
      -- variation selector, joiner and skin-tone modifiers
      '[[:space:].,!;:…''"’‘«»()*~_–—❤♥☺🙏😊🙂🥰😍🤗😘😚😀😃😄😁😇🥹🫶💓💕💖💗💘💙💚💛💜💝💞🧡🤍🖤🤎🌹🌸💐✨\uFE0F\u200D\U0001F3FB-\U0001F3FF-]', '', 'g')) as r
    from phrased
  )
  select coalesce(
    p_body is not null
    and length(btrim(p_body)) between 1 and 160
    and (select r from rest) = ''
    and (select w from words) <@ array[
      -- gratitude
      'thanks', 'thank', 'thankyou', 'thanx', 'thnx', 'thx', 'ty', 'tysm', 'cheers', 'appreciate',
      'appreciated', 'grateful', 'спасибо', 'спасиб', 'спс', 'благодарю', 'благодарим', 'дякую',
      'merci', 'gracias', 'danke', 'grazie', 'obrigado', 'obrigada', 'mulțumesc', 'multumesc',
      'mersi', 'dziękuję', 'dzięki', 'köszönöm',
      -- goodbye
      'bye', 'goodbye', 'byebye', 'cya', 'пока', 'свидания', 'встречи', 'зустрічі', 'доброго',
      'хорошего', 'гарного', 'всего', 'дня', 'вечера', 'выходных',
      -- kisses
      'x', 'xx', 'xxx', 'xo', 'xoxo',
      -- words that only intensify or address
      'you', 'u', 'so', 'very', 'much', 'many', 'a', 'lot', 'lots', 'again', 'really', 'all', 'for',
      'everything', 'it', 'see', 'soon', 'take', 'care', 'big', 'and',
      'большое', 'огромное', 'вам', 'тебе', 'очень', 'ещё', 'еще', 'за', 'всё', 'все', 'до',
      'дуже', 'щиро', 'вам', 'тобі', 'beaucoup', 'muchas', 'mille', 'schön', 'vielen', 'muito'
    ]
    and (
      -- no words: at least one affectionate emoji, not bare punctuation
      (cardinality((select w from words)) = 0
       and (select t from norm) ~ '[❤♥☺🙏😊🙂🥰😍🤗😘😚😀😃😄😁😇🥹🫶💓💕💖💗💘💙💚💛💜💝💞🧡🤍🖤🤎🌹🌸💐✨]')
      or (select w from words) && array[
        'thanks', 'thank', 'thankyou', 'thanx', 'thnx', 'thx', 'ty', 'tysm', 'cheers', 'appreciate',
        'appreciated', 'grateful', 'спасибо', 'спасиб', 'спс', 'благодарю', 'благодарим', 'дякую',
        'merci', 'gracias', 'danke', 'grazie', 'obrigado', 'obrigada', 'mulțumesc', 'multumesc',
        'mersi', 'dziękuję', 'dzięki', 'köszönöm',
        'bye', 'goodbye', 'byebye', 'cya', 'пока', 'свидания', 'встречи', 'зустрічі',
        'x', 'xx', 'xxx', 'xo', 'xoxo'
      ]
    ),
    false);
$$;

revoke all on function crm_private.is_closing_message(text)
  from public, anon, authenticated, service_role;

comment on function crm_private.is_closing_message(text) is
  'True only for a short thank-you or goodbye (words from a closing vocabulary, at least one of gratitude or farewell, affectionate emoji). Requests, agreements, dates, thumbs-up and attachments are false. Used to decide whether a studio reaction answered a client message.';

create or replace function crm_private.studio_reaction_acknowledged_at(p_inbound_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select min(coalesce(r.sent_at, r.provider_timestamp, r.created_at))
  from public.communication_messages i
  join public.communication_conversations c
    on c.id = i.conversation_id and c.artist_id = i.artist_id
  join public.communication_messages r
    on r.conversation_id = i.conversation_id and r.artist_id = i.artist_id
  where i.id = p_inbound_id
    and i.direction = 'inbound'
    and r.direction = 'outbound'
    and r.message_type = 'reaction'
    and r.origin in ('crm', 'provider_app')
    and r.status in ('sent', 'delivered', 'read')
    and coalesce(r.sent_at, r.provider_timestamp, r.created_at) > coalesce(i.provider_timestamp, i.created_at)
    -- Only a thank-you or a goodbye is answered by a reaction, or a message
    -- the classifier or an operator marked no_reply_needed: two independent
    -- signals agree. Anything else, with or without a question mark, waits
    -- for a person; a classifier that failed or never ran leaves no mark.
    and (crm_private.is_closing_message(i.body) or exists (
      select 1 from crm_private.client_reply_marks m
      where c.client_id is not null
        and m.artist_id = c.artist_id
        and m.client_id = c.client_id
        and m.message_at = coalesce(i.provider_timestamp, i.created_at)
        and m.reply_state = 'no_reply_needed'))
    -- The classifier may keep it open; it never closes it on its own. A mark
    -- names the exact inbound it classified (service_record_client_reply_state
    -- stores its time), so a mark on a later message elsewhere does not
    -- reopen this one.
    and not exists (
      select 1 from crm_private.client_reply_marks m
      where c.client_id is not null
        and m.artist_id = c.artist_id
        and m.client_id = c.client_id
        and m.message_at = coalesce(i.provider_timestamp, i.created_at)
        and m.reply_state = 'reply_required');
$$;

revoke all on function crm_private.studio_reaction_acknowledged_at(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.studio_reaction_acknowledged_at(uuid) is
  'When a studio reaction after this inbound acknowledged it. Null without a reaction, when the message is neither a plain thank-you or goodbye (crm_private.is_closing_message) nor marked no_reply_needed, or when it is marked reply_required.';
