-- 20260924055000_enable_today_pulse.sql
--
-- Phase 4 activation (data only): CRM Today renders the server-side pulse
-- (get_today_pulse). Shipped as its own migration after the Phase 4 code
-- (20260924050000) was released with the switch off and read back.
-- Telegram /today keeps CRM_TODAY_PULSE_ENABLED=false: Telegram linking is
-- off in production, so that switch has nothing to serve yet.
--
-- Rollback: a later migration setting today_pulse = false. The CRM falls
-- back to the existing Today view; no row is written or lost.

update crm_private.crm_agent_config
set today_pulse = true
where singleton;
