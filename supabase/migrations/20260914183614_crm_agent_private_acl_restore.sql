-- Restore the original private-helper ACL after replacing the CRM AI context
-- and watermark functions. SECURITY DEFINER service RPCs call these helpers as
-- their owner; the Data API service_role does not need direct EXECUTE access.

revoke execute on function crm_private.client_ai_context(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function crm_private.client_ai_watermark(uuid, uuid)
  from public, anon, authenticated, service_role;
