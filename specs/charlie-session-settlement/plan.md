# Implementation and guarded rollout

1. Verify exact canonical base, production migration head, two session ids, receipt and bank reconciliation. Do not infer one session from project-level payments.
2. Ship a versioned, exact-identity guard migration. In staging/CI with no production customer row it is a no-op; in production it aborts on *any* mismatch.
3. Verify migration order, entire existing pgTAP suite, CRM typecheck/build and exact-head CI. Use a bounded PR and recheck the base and PR SHA before merge.
4. After merge, verify canonical post-merge CI and launch protected database-only release if available. Do not call Supabase MCP for direct production DML/DDL.
5. Read back target session, unrelated sibling, invoice totals, ledger transaction count, Monzo evidence link and activity audit.

The ledger is immutable; marking the session paid is **not** a new payment.
