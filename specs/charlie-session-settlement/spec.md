# Completed session settlement: Charlie Sims, 27 October 2026

**Incident.** A 27 Oct 11:00–18:00 completed session has `sessions.price = NULL` and `sessions.payment_status = unpaid` despite exact session-linked £250 paid deposit and sole £730 issued invoice (paid and linked to that session). On 29 Oct the £730 Monzo transfer was reconciled to the already-recorded manual receipt; the money ledger is complete and must not be re-credited.

**Approved target.** Correct **only** session `438b706a-ea4e-461d-96f5-4989c232afb3`: final price £980, payment status paid. Charlie's other completed session in the same project must be untouched and must not receive this deposit/invoice.

**Fail-closed rules.** Exact artist, project, client, date/time, terminal session and previous price/status; exact £250 deposit request linked only to this session; exact £730 paid invoice with one line for this session, no discount/credit, no outstanding balance; exact single credit per request; exactly matching Monzo evidence association to the pre-existing £730 receipt. Any drift aborts migration. CI/staging have no real customer record and must do no write. Update only `sessions.price` and `sessions.payment_status`; create a redacted activity audit event; do **not** write to `payment_transactions`, `payment_requests`, `invoices` or other sessions.

**Acceptance.** Exact SHA gated CI and migration checks; production DB release only through canonical workflow; post-release readback shows status `paid` and price £980 for 27 Oct, other session unchanged, invoice outstanding £0, Monzo candidate matched, only two original ledger transactions sum to £980, one bank evidence link, one activity event, no duplicated payment.

**Limit.** This is a one-time, narrowly scoped historical data reconciliation. It does not add general automatic payment-status synchronization for future sessions and must not be represented as such.
