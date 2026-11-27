# Domain email for Vladimir CRM
Status: draft; production sending unchanged.
## Requirements
- Vladimir's approved client correspondence and transactional emails use info@vishartattoo.com through Resend on the free plan. Gmail remains the authorized inbound mailbox and historical source; no Calendar/OAuth or Kristina routing changes.
- Replies sent to the domain address must be associated with the authorized client and visible in CRM, including existing conversations. No message body or credential may cross artist boundaries. HTML and plain text must remain supported.
- Preserve approval, outbox leases, retry safety, cancellation and lifecycle policies; never fall back to a different sender after an ambiguous provider outcome. Keep accepted, delivered, failed and uncertain outcomes distinguishable.
- Sending-only domain-scoped secret in Worker secret storage; no secret in repository, database, prompts or client-visible output.
- The separate guide delivery PR #1359 is not part of this change. Avoid duplicating its sender or modifying its rollout.
## Acceptance
1. Read existing Gmail threads and replies to the domain alias; reject the same alias for unrelated mailboxes/clients.
2. From and Reply-To exact; test recipient restricted to owner's mailbox before enabling general sending.
3. Outbound history and replies correlate using actual RFC Message-ID and provider receipt, never assume a Resend UUID is a Gmail thread ID.
4. Ambiguous timeout, provider limits, retries, concurrent drains and rollback cannot generate duplicate sends.
5. Exact-head tests pass, then controlled receipt/reply and CRM-history verification; no real client test traffic. Free quota respected.
6. Kristina and the legacy Gmail read/send path remain unchanged until explicit gated activation.

## Owner decision, 2026-11-27
Temporarily reuse the existing domain-scoped sending-only Cloudflare Worker secret `LEAD_MAGNET_RESEND_API_KEY` for both the guide and ordinary CRM correspondence. Do not create or rotate another key or grant extra permissions. Independent feature flags and idempotency namespaces stay separate. Later credential separation can be reviewed independently.
