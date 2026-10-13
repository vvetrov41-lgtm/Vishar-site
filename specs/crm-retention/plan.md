# Plan

| Layer | Change |
|---|---|
| Database | `20261013150000_retention_dry_run.sql`: assessment, `retention_runs`, two RPCs, dry-run-only constraint. pgTAP `336_retention_dry_run.sql`; ACL rows in `050_rls_roles.sql`. |
| Worker | `runRetentionDryRun()` in `workers/lib/crm-agent.js`, called by the CRM agent drain; `RETENTION_RPCS` allowlist. `scripts/test-retention-dry-run.mjs`. |

Release: database (dispatch), then TattooAI Worker. Verification: a
`retention_runs` row with trigger `scheduled` appears within one drain tick
and reports 0 candidates; enquiry, client and file counts unchanged.
