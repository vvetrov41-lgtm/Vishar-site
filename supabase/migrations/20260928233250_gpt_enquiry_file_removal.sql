-- Unified GPT v2: removing an enquiry reference file keeps the CRM order.
--
-- The CRM deletes the private Storage object first and only then the
-- manifest, and remove_enquiry_reference_manifest refuses while the object
-- still exists. This read returns the object path for a file the active Artist
-- owns, so the GPT Worker can delete it with the caller's own bearer (Storage
-- policy decides) before calling gpt_remove_enquiry_file.

create or replace function public.gpt_prepare_enquiry_file_removal(p_file_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid; v_path text;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_enquiries');
  select e.artist_id, f.storage_path into v_artist, v_path
  from public.enquiry_files f join public.enquiries e on e.id = f.enquiry_id
  where f.id = p_file_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'file');
  return jsonb_build_object('file_id', p_file_id, 'bucket', 'crm-files', 'storage_path', v_path);
end;
$$;

revoke all on function public.gpt_prepare_enquiry_file_removal(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_prepare_enquiry_file_removal(uuid) to authenticated;
