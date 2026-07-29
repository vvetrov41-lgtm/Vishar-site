-- 0008_storage.sql
--
-- One private bucket, `crm-files`, and the policies that make a well-formed
-- path insufficient on its own.
--
-- The bucket is never public. No public URL is ever generated or stored; reads
-- happen through short-lived signed URLs minted per request.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- The bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'crm-files',
  'crm-files',
  false,
  4 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Path ownership
--
-- The canonical layout is:
--   clients/{client_id}/enquiries/{enquiry_id}/references/{file_id}.{ext}
--   clients/{client_id}/projects/{project_id}/designs/{file_id}.{ext}
--   clients/{client_id}/projects/{project_id}/sessions/{file_id}.{ext}
--   clients/{client_id}/projects/{project_id}/healed/{file_id}.{ext}
--
-- Shape alone proves nothing: a caller could construct a syntactically perfect
-- path for another client. These helpers re-derive ownership from the path and
-- require a matching manifest row whose own trigger already proved the path is
-- canonical for that row. A forged path has no manifest and therefore fails.
--
-- They also return false for a bare prefix, which is what stops an unrestricted
-- listing of the bucket: there is no path shape that matches "everything".
-- ---------------------------------------------------------------------------

create or replace function public.crm_storage_object_is_known(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select (public.can_manage_crm() or crm_private.is_service_backend())
  and (
    exists (
    select 1
    from public.enquiry_files f
    join public.enquiries e on e.id = f.enquiry_id
    where f.storage_path = p_name
      and p_name = 'clients/' || e.client_id || '/enquiries/' || e.id
                   || '/references/' || f.id || '.' || f.safe_extension
    )
    or exists (
    select 1
    from public.project_files pf
    join public.projects pr on pr.id = pf.project_id
    where pf.storage_path = p_name
      and p_name = public.project_file_storage_path(pr.client_id, pr.id, pf.category, pf.id, pf.safe_extension)
    )
  );
$$;

comment on function public.crm_storage_object_is_known(text) is
  'True only for an object key that matches a file manifest whose canonical path was validated on insert.';

-- Read access: an active owner or booking manager, and only for an object that
-- corresponds to a real manifest row.
create or replace function public.crm_storage_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select (public.can_manage_crm() or crm_private.is_service_backend())
     and public.crm_storage_object_is_known(p_name)
$$;

-- Write access: the same identity checks, plus a non-ready manifest for a
-- booking manager. Owners and the backend may repair a missing object whose
-- manifest is already ready; a manager cannot silently replace it. Objects are
-- never uploaded ahead of their database row, so a partial upload always
-- leaves something reconcilable.
create or replace function public.crm_storage_object_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select (public.can_manage_crm() or crm_private.is_service_backend())
     and public.crm_storage_object_is_known(p_name)
     and (
       public.is_owner()
       or crm_private.is_service_backend()
       or exists (
         select 1 from public.enquiry_files f
         where f.storage_path = p_name and f.upload_state <> 'ready'
       )
       or exists (
         select 1 from public.project_files pf
         where pf.storage_path = p_name and pf.upload_state <> 'ready'
       )
     );
$$;

revoke all on function public.crm_storage_object_is_known(text)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_storage_object_readable(text)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_storage_object_writable(text)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_storage_object_is_known(text) to authenticated, service_role;
grant execute on function public.crm_storage_object_readable(text) to authenticated, service_role;
grant execute on function public.crm_storage_object_writable(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Bucket metadata is visible to active CRM staff only, so the bucket is not
-- enumerable by an anonymous caller.
drop policy if exists crm_files_bucket_visible on storage.buckets;
create policy crm_files_bucket_visible on storage.buckets
  for select
  to authenticated, service_role
  using (
    id = 'crm-files'
    and (public.is_active_user() or crm_private.is_service_backend())
  );

drop policy if exists crm_files_read on storage.objects;
create policy crm_files_read on storage.objects
  for select
  to authenticated, service_role
  using (
    bucket_id = 'crm-files'
    and (public.is_active_user() or crm_private.is_service_backend())
    and public.crm_storage_object_readable(name)
  );

drop policy if exists crm_files_insert on storage.objects;
create policy crm_files_insert on storage.objects
  for insert
  to authenticated, service_role
  with check (
    bucket_id = 'crm-files'
    and public.crm_storage_object_writable(name)
  );

drop policy if exists crm_files_update on storage.objects;
create policy crm_files_update on storage.objects
  for update
  to authenticated, service_role
  using (
    bucket_id = 'crm-files'
    and (public.is_owner() or crm_private.is_service_backend())
    and public.crm_storage_object_is_known(name)
  )
  with check (
    bucket_id = 'crm-files'
    and (public.is_owner() or crm_private.is_service_backend())
    and public.crm_storage_object_is_known(name)
  );

-- Deletion is limited to the owner and to backend-controlled compensating
-- cleanup and reconciliation. A booking manager cannot destroy client files.
drop policy if exists crm_files_delete on storage.objects;
create policy crm_files_delete on storage.objects
  for delete
  to authenticated, service_role
  using (
    bucket_id = 'crm-files'
    and (public.is_owner() or crm_private.is_service_backend())
  );

-- Every policy above is scoped `TO authenticated, service_role`, so an
-- anonymous caller matches no policy at all and sees nothing — and the helper
-- functions are never evaluated on its behalf, so it cannot use them as an
-- existence oracle either. The bucket row pins `public = false`, so there is no
-- anonymous read path and no public URL.
