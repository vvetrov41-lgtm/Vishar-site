# Tasks

- [x] Audit the data flow and reproduce 23 / 236.8 on production read-only.
- [x] Canonical predicate and summary/Today/reminder rewiring.
- [x] Gmail Worker evidence and bounded first-reply lookup.
- [x] pgTAP regression suite and Worker tests.
- [ ] Database release and Gmail Worker redeploy.
- [ ] Production readback of the named enquiries, count and median.

## Follow-up (2026-10-04, 20261004120000_reply_semantics_followup)

- [x] Operator attestation for replies the CRM could not see
  (`set_enquiry_reply_outside_crm`, `get_enquiry_reply_state`, enquiry page).
  Manual Instagram enquiries such as ENQ-2026-0061 stay in analytics.
- [x] Gmail first-reply time only from a complete lookup of the enquiry
  window (paged, shared extra-call pool, `complete` flag).
- [x] `outbound_message_marks_enquiry_reviewing`, the linked-conversation and
  Gmail variants, and `attention_comm_facts` use provider-accepted messages
  only.
- [ ] GPT/MCP operation `setEnquiryReplyOutsideCrm` (parity: implement_now).
