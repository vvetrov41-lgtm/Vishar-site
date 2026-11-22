# Acceptance checks

- Validate an explicit studio receipt with an older unallocated deposit.
- Validate a custom cash deposit and a retry with the same operation ID.
- Verify that Monzo matching remains explicit and that receipt linking does not post a second ledger credit.
- Check database, browser and plugin contracts before release. Do not reconcile historical client records as part of testing.
