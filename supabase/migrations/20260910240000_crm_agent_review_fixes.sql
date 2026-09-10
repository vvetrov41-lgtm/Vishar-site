-- Corrective review pass: enquiry content participates in the client AI
-- watermark, so editing it must enqueue a fresh derived-state job even when
-- intake_state and status do not change.

create or replace function crm_private.enqueue_enquiry_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_watermark text;
begin
  if new.intake_state <> 'complete' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.intake_state = 'complete'
     and old.status is not distinct from new.status
     and old.project_type is not distinct from new.project_type
     and old.placement is not distinct from new.placement
     and old.approximate_size is not distinct from new.approximate_size
     and old.cover_up is not distinct from new.cover_up
     and old.preferred_timing is not distinct from new.preferred_timing
     and old.idea is not distinct from new.idea
     and old.archived_at is not distinct from new.archived_at then
    return new;
  end if;

  begin
    v_watermark := crm_private.client_ai_watermark(new.artist_id, new.client_id);
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id,
      new.client_id,
      'enquiry:' || new.id::text || ':' || left(coalesce(v_watermark, 'missing'), 32)
    );
  exception when others then null;
  end;
  return new;
end;
$$;

-- Recreate the trigger so UPDATE OF covers every enquiry field hashed by the
-- watermark and exposed to the prompt projection.
drop trigger if exists enquiries_enqueue_client_ai on public.enquiries;
create trigger enquiries_enqueue_client_ai
  after insert or update of
    intake_state,
    status,
    project_type,
    placement,
    approximate_size,
    cover_up,
    preferred_timing,
    idea,
    archived_at
  on public.enquiries
  for each row execute function crm_private.enqueue_enquiry_client_ai();
