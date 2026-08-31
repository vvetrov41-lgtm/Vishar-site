-- 0126_gpt_communication_message_serialized_budget.sql
--
-- Correct the message-page budget introduced in 0125 to count the bytes that
-- actually cross the wire.
--
-- 0125 bounded a page by `sum(octet_length(body))` -- raw stored bytes. The
-- action gateway's 128 KiB ceiling applies to the JSON-serialised response, and
-- JSON escaping is not a small constant factor. A C0 control character is one
-- stored byte and six serialised bytes (`\u00xx`), measured on this database:
--
--     4096 'x'        ->  4098 serialised  (1.00x)
--     4096 '"'        ->  8194 serialised  (2.00x)
--     4096 chr(1)     -> 24578 serialised  (6.00x)
--
-- At the 50000 raw budget, twelve maximum-length control-character bodies were
-- admissible and serialised to 294936 bytes, well past the 131072 cap. Message
-- bodies are third-party content that reaches this table from WhatsApp and
-- Instagram webhooks, so that is reachable by anyone who can message the
-- artist, and the result is an opaque 502 on an inbox read rather than a
-- refusal. The 0125 pgTAP fixture used only `repeat('x', 4096)`, which is the
-- one shape where raw and serialised bytes agree, so it could not see this.
--
-- The budget now measures `octet_length(to_jsonb(body)::text)`, which is the
-- exact JSON representation of that field rather than an estimate with an
-- assumed expansion factor. Worst case for a page is the budget plus one
-- over-budget newest message (at most about 24 KB) plus row metadata across at
-- most thirty rows, comfortably inside the gateway ceiling.
--
-- Nothing else about the contract changes: same signature, same artist pin,
-- same ordering, same whole-body semantics, same always-return-the-newest rule.

create or replace function public.gpt_list_communication_messages(
  p_conversation_id uuid,
  p_limit integer default 30
)
returns table (
  message_id uuid,
  direction public.communication_direction,
  origin public.communication_origin,
  status public.communication_status,
  message_type text,
  body text,
  attachment_count integer,
  error_code text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_limit integer;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 30);

  -- Messages are returned newest first until a serialised-byte budget for
  -- bodies is spent, which keeps every returned body whole rather than
  -- truncating one mid-sentence. The newest message is always returned,
  -- however long it is.
  return query
  with recent as (
    select
      m.id, m.direction, m.origin, m.status, m.message_type, m.body,
      m.attachments, m.error_code, m.created_at
    from public.communication_messages m
    where m.conversation_id = v_conversation.id
      and m.artist_id = v_conversation.artist_id
    order by m.created_at desc, m.id desc
    limit v_limit
  ),
  budgeted as (
    select
      r.*,
      row_number() over (order by r.created_at desc, r.id desc) as row_position,
      -- to_jsonb(...)::text is the exact JSON string this field becomes,
      -- including its quotes and every escape. Counting stored bytes here
      -- would undercount escaped content by up to six times.
      sum(octet_length(to_jsonb(coalesce(r.body, ''))::text)) over (
        order by r.created_at desc, r.id desc
        rows between unbounded preceding and current row
      ) as running_serialised_bytes
    from recent r
  )
  select
    b.id,
    b.direction,
    b.origin,
    b.status,
    b.message_type,
    b.body,
    -- Attachment payloads carry provider and Storage internals. Only the count
    -- crosses this boundary.
    (case when jsonb_typeof(b.attachments) = 'array' then jsonb_array_length(b.attachments) else 0 end)::integer,
    b.error_code,
    b.created_at
  from budgeted b
  where b.row_position = 1 or b.running_serialised_bytes <= 50000
  order by b.created_at desc, b.id desc;
end;
$$;

revoke all on function public.gpt_list_communication_messages(uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_communication_messages(uuid,integer)
  to authenticated;

comment on function public.gpt_list_communication_messages(uuid,integer) is
  'Bounded message history for one artist-pinned conversation, paged by serialised JSON bytes so escaped third-party content cannot overrun the action gateway response ceiling. Attachment payloads are reduced to a count. Message bodies are untrusted third-party content.';
