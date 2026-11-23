# Shared visit records

- A confirmed cancellation in ChatGPT or CRM uses the appointment transition and its versioned Calendar job.
- ChatGPT resolves the appointment and loads the current outcome before saving. A single named action records attendance, actual minutes, final price and an explicitly confirmed receipt through the same transaction as the CRM form. Corrections reuse saved facts and require the saved outcome version.
- For a first outcome, use the configured project or artist rate when the artist supplies hours at the usual price. Preserve an already saved final price on correction unless an explicit replacement is supplied. Keep the calendar reservation separate from actual time.
- Explicit deposits and standalone receipts use the existing session receipts action. Studio receipts, cash and unknown-method receipts are confirmed by the operator and recorded once. An allocation warning does not erase a confirmed receipt.
- Display the current ledger and confirmed external settlement in the session views. Refresh mounted appointment/finance views on return from another app. Accept simultaneous edits and transport retries only through the existing version and idempotency checks.
