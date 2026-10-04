# Plan

- Migration `20261004090000_canonical_enquiry_reply_evidence.sql`:
  `crm_private.gmail_client_outbound_messages` (time-only Gmail SENT
  evidence, backfilled from existing Gmail observations),
  `crm_private.gmail_enquiry_reply_checks`, the predicate functions, the
  rewired `pulse_summary`, `pulse_items` (`new_enquiry` only) and
  `unanswered_waiting_since` (`enquiry` only), and three backend-only RPCs
  for the Gmail Worker.
- Gmail Worker (`workers/gmail-metadata-snapshot.js`): alternate runs per
  mailbox between client history lookups and enquiry first-reply lookups;
  record every SENT message to a known client seen in the newest page. Stays
  within the 40-subrequest budget.
- Rollout: database through the private production release, then the Gmail
  Worker through the backend Gmail redeploy at the exact trunk head.
