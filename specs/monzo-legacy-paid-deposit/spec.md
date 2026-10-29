# Verified Monzo transfer for previously marked-paid project deposit

## Incident
A legitimate four-hour booking on 17 December has a £150 paid project
deposit and a verified Monzo £150 transfer. The project has no payment request
or immutable payment transaction. The reconciler only offers outstanding
deposit requests and already-recorded invoice receipts, so the client is absent.

## Narrow recovery
The human finance operator chooses an existing paid project and its sole
confirmed tattoo session from server-calculated candidates. The bank event
must be verified, owned by the same artist, in the same currency and amount,
and within seven days of the project's creation. The session must exactly
match the current duration-based deposit tier. The project must have no
payment requests or ledger receipts. Any ambiguity needs explicit operator
selection; the server never guesses.

One transaction creates a pending deposit request, ties the candidate to it,
and uses the existing guarded Monzo confirmation RPC to write one immutable
provider credit. The project stays paid, and the normal CRM financial reports
see the actual received £150. The bank transaction ID and UUID idempotency
keys prevent duplicates and conflicting retries. No client-facing charge,
deposit email, or booking-card resend is permitted.

## Fail-closed conditions
No role with only view-finance can mutate; no artist can select another
artist's deposit. No cancelled, archived, ambiguous multi-session, mismatched
amount/currency, existing-request, already-matched, ignored or unverified
transfer may pass. The hook migration verifies the exact previous notification
function definitions before changing them.

## Acceptance
- Historical candidate shows Quaid Shah, 17 December 11:00, £150.
- Selecting it confirms one £150 bank transaction, a paid request and the
  correct client/project/session, with no duplicate money or outbound message.
- Repeated submit returns replayed and does not change the ledger.
- Existing invoice-receipt and ordinary outstanding-deposit matching are
  unaffected.
- Validate on staging with synthetic data before any production mutation.
- Production deployment requires exact-head CI, migration readback and a
  read-only account/ledger verification after user-authorized match.
