# Monzo ↔ already recorded invoice receipt reconciliation

## User problem / factual baseline (27 Oct 2026)
Charlie Sims paid £250 deposit plus a further £730 for the 11:00–18:00 session. A CRM invoice for the £730 balance was manually marked paid at 18:37. The verified Monzo incoming transfer of £730 occurred at 18:23 and remains unmatched because the existing Monzo workflow accepts only open `deposit` requests. The paid `additional_payment` request is ineligible.

## Acceptance
- Payments shows an additional option to attach a verified Monzo transfer to an existing *paid manual invoice receipt* of the same amount, currency and artist.
- The UI shows the CRM client's name, existing invoice number, recorded amount and time. It never guesses on amount alone.
- Explicit financial confirmation links the bank evidence to the **existing** receipt. No payment is inserted into the immutable ledger, no invoice balance changes, no client notification or provider charge happens.
- One bank candidate may point to one receipt, and one receipt to one bank candidate. An existing identical link is idempotent; conflicting requests fail.
- Verified webhook event, provider account, artist role, artist ID, amount, currency, valid invoice, positive manual receipt and bounded date window are revalidated within the database transaction.
- Owner/artist with `manage_finance` may link; read-only and unrelated artists must be denied even if they forge RPC parameters.
- The traditional open-deposit reconciliation workflow must remain unchanged and functional.
- Linked candidates appear in the processed section with correct client and no second credit. Reload is idempotent.
- Do not modify `payment_transactions`; the ledger is immutable. A narrow link table is the authorised evidence index.

## Operator parity
Existing plugin can list Monzo candidates and match/confirm open deposits. Linking to an already recorded invoice receipt is a **gap** in GPT/MCP. Add an explicit bounded action only after database acceptance and verification, never a general SQL or arbitrary transaction patch endpoint.

## Release
No direct production SQL DDL or DML. Only exact-head gated database release and CRM web deploy, followed by production readback. Other artist routes and bookings must remain unchanged.
