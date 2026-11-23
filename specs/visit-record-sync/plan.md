# Implementation and release

Use the existing appointment transition, visit outcome, and manual receipt workflows. Expose a bounded ChatGPT visit operation with Artist, appointment and finance permissions and canonical idempotency. Broaden the read operation, applying the finance ceiling to financial fields. Keep separate deposit and balance inputs. Align checkout's display with the already recorded external-settlement evidence and refresh views when the user returns to CRM.

Validate the same write through ChatGPT and website entry points, replay, stale version, permissions, outstanding balances, and calendar behavior using synthetic fixtures outside production. Ship the database before exposing the operation in the Worker and refresh the live plugin catalog. Verify the production manifest, deployed Worker, and a read-only visit.
