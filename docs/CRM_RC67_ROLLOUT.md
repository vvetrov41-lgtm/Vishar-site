# Vishar CRM production rollout — rc67 (PR #343 + PR #352)

Rollout record for the stacked changes in PR #343 and PR #352.
Written during the rollout; states only what was actually observed.

## Release artefact

- Branch: `release/private-crm-rc67-record-archival-mobile-projects`
- Exact head: `61b572cc1c4775eb73dfcde06d32a818d28d890f` (= PR #352 head, unmodified)
- Stack: `agent/payment-redirect-production-activation` (`960e76b`)
  -> PR #343 `agent/payment-redirect-on-monzo-runtime` (`817ae0a`)
  -> PR #352 `agent/mobile-record-archive-and-project-tab` (`61b572c`)

Both PRs were green at their exact heads before the release branch was cut
(5/5 checks each: static-validation, Public site and Worker, Private CRM,
Supabase migrations and pgTAP, Cloudflare Pages).

## PR #343 — not re-deployed, and why

PR #343 moves the personalized deposit redirect onto the existing
`vishar-monzo-api-production` Worker. That code is already in production and
production is one iteration ahead of this PR.

Live Worker source read from Cloudflare (account `787a19ac...`, script
`vishar-monzo-api-production`):

    var PAYMENT_PATH_PREFIX = "/pay-by-bank-transfer";

PR #343 head has `'/pay-by-bank-transfer/'` (trailing slash). The live value
without the slash is the rc63/rc66 variant, which came after #343:

| Release | Time (2026-08-18) | Outcome |
| --- | --- | --- |
| rc61 (activation of PR #343) | 16:17 | Worker deployed; gate failed on a post-deploy webhook status assertion |
| rc62 Cloudflare route inspection | 17:46 | inspection only |
| rc63 payment route recovery | 18:13 | route pattern changed to `/pay-by-bank-transfer*` |
| rc66 (PR #350) | 18:55 | failed: `payment route not propagated yet: status=404`, 10 polls |

Independently reproduced: `GET https://vishartattoo.com/pay-by-bank-transfer/<uuid>`
returns the Cloudflare Pages 404 page, byte-identical in headers and body
(2794 bytes) to any other unknown path — so the Worker route is still not
matching at the edge.

Conclusion: re-deploying the Monzo Worker from this stack would overwrite the
newer rc63/rc66 route pattern with #343's older one. That is a regression of
in-flight work owned by PR #350 / rc66, and it would not fix the route.
The Monzo Worker was therefore left untouched by this rollout.

## PR #352 — the actual rollout

Verified as a strict forward step against the last releases that reached
production:

- vs `release/private-crm-rc48-project-detail-deposit-failclosed`
  (last successful CRM Pages deploy, 08:06): `admin/` differs only by the nine
  files this PR changes; `supabase/migrations/` differs only by `0062`.
- vs `release/private-crm-rc47-project-detail-operational`
  (last successful DB deploy, 07:03): one new migration,
  `supabase/migrations/0062_record_archival.sql`.

No rollback of rc47 project-detail or rc48 deposit work.

### Migration risk

`0062_record_archival.sql` performs no DDL on tables. The `archived_at`
columns already exist (`0002_profiles_clients.sql:161`,
`0003_enquiries_files.sql:83`, `0004_projects_sessions.sql:32`) and working
lists already filter `archived_at is null`. The migration only:

- moves the 0048 edit bodies to `crm_private.update_client_details_core` /
  `crm_private.update_enquiry_details_core` and revokes all execute on them;
- re-creates the canonical public RPCs with a reserved `{_archive: true}`
  command, owner-gated via `public.is_owner()`;
- blocks archival while an active project references the record (`55000`).

The public authenticated RPC inventory is unchanged.

## Deployment sequence

Database first, so the `{_archive: true}` command exists before the UI that
calls it ships.

    deploy-private-production-database.yml
      ref=release/private-crm-rc67-record-archival-mobile-projects
      approved_sha=61b572cc1c4775eb73dfcde06d32a818d28d890f
      deploy=false                                    # dry-run checkpoint
      then deploy=true, approval_phrase=DEPLOY_PRIVATE_CRM_DATABASE

    deploy-private-production-crm.yml
      ref=release/private-crm-rc67-record-archival-mobile-projects
      approved_sha=61b572cc1c4775eb73dfcde06d32a818d28d890f
      deploy=true, approval_phrase=DEPLOY_PRIVATE_CRM_ONLY

Both workflows target the `crm-production` GitHub environment, which holds
runs in `waiting` until a reviewer approves them. That approval cannot be
granted from an agent session.

## Post-rollout checks

1. Delete an erroneous enquiry and an erroneous client from the mobile CRM.
   Expect a destructive confirmation before the RPC, and the record to leave
   normal lists while remaining recoverable. A record with an active project
   must be refused with the active-project message.
2. Bottom navigation on phones shows Dashboard, Enquiries, Appointments,
   Projects.
3. Clients appears in the More sheet, in the Operations group.

Covered by `admin/src/test/navigation-shell.test.tsx`,
`admin/src/test/record-edit-ui.test.tsx`,
`admin/src/test/record-edit-api.test.ts`,
`admin/src/test/consequential-client.test.ts` and
`supabase/tests/213_record_archival.sql`.
