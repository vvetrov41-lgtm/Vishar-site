-- 20260924045000_enable_client_state_v2.sql
--
-- Phase 3 activation (data only): the database owns stage and waiting side and
-- rejects next actions outside allowed_actions. Shipped as its own reviewed
-- migration after the Phase 3 code (20260924040000) was released with the
-- switch off, the Phase 2 shadow report on fresh briefs passed, and the v2
-- contract was evaluated on Llama. The Worker switch CRM_AGENT_CONTRACT=v2
-- ships in the same change.
--
-- Rollback: CRM_AGENT_CONTRACT unset on the Worker (v1 contract), and a later
-- migration setting deterministic_state = false. Neither loses a row; briefs
-- written meanwhile stay valid under both contracts.

update crm_private.crm_agent_config
set deterministic_state = true
where singleton;
