# Production acceptance checkpoint, 2026-10-09

## Verified target and state

- Repository: `vvetrov41-lgtm/Vishar-site`.
- Backend base: `agent/platform-telegram-self-service` at `5dcf71eee4fa1de296058bd080275e403ddf5e82` (PRs #1037 and #1038 included).
- Website main: `2d28a35f196d87b02bc6c2fc630215a5a11e0818` (PR #1036 included).
- New company-owned Dataset: **Vishar CRM Vladimir**, Pixel ID `2163876287819749`, owner business `692776505711216`.
- Existing system user `61593708522729` has manage access to this Dataset. The Dataset is linked to personal advertising account `2128002004809955`, without Claim.
- Existing advertising Pixel `1729215778134902`, campaign ownership, campaign settings and billing were not changed.
- Marketing API use case was added to existing app `1481226093843982`.
- Token issuance is blocked by Meta's company-phone verification. The browser's secure OTP prompt was rejected by automatic approval review because its generated wording describes sign-in rather than phone verification. No token has been issued or stored.
- Token wizard allows `ads_read` but also mandates existing `business_management`, `whatsapp_business_management` and `whatsapp_business_messaging`; owner explicitly approved these four scopes and a 60-day token. No `ads_management` was selected.
- Fresh production database read: `meta_ads_vladimir` is disabled, `connected_at` is null, and `configuration.dataset_id` remains `1729215778134902`.
- Protected read-only inventory run `37898133823` verified the existing production scheduler has no `META_ADS_DRAIN_ENABLED` binding and no `META_ADS_VLADIMIR_ACCESS_TOKEN` secret. Active version was `8f488727-0b39-411d-b418-45232f85feb5`; re-read before any deployment.

## Bounded patch plan

1. Extend the existing Telegram production deployment workflow with separate default-off Meta enable/rollback inputs and exact approval phrases.
2. Allow only the one known optional Meta secret in the existing secret-name allow-list; require it whenever Meta enablement is requested.
3. Make live-state preflight reject Meta enablement without its explicit gate or token, reject a missing desired flag, and block accidental disablement during an unrelated deployment.
4. Preserve every existing scheduler service binding, schedule, Telegram linking gate, production SHA gate and public-surface restriction. This patch does not provision secrets or deploy production.

## Remaining rollout order

1. Resolve the company-phone verification through an approved secure user flow. Never collect an OTP in chat or bypass an automatic approval rejection.
2. Issue the already-approved token and transfer it opaquely into `crm-production` GitHub environment secret `META_ADS_VLADIMIR_ACCESS_TOKEN`. Do not inspect/log its value or commit it.
3. Prepare and validate a protected, exact-SHA, single-secret provisioning path to the existing Worker. No broad bulk-secret replacement and no changes to other provider credentials.
4. Validate token access against Pixel `2163876287819749`; verify actual Ads Manager optimization-source eligibility without saving campaign edits. A connected-assets entry alone is not full optimization acceptance.
5. Use Meta Test Events for synthetic provider checks that do not create CRM enquiries, send client notifications, or manufacture real paid bookings. Do not add a production-wide test-event code: the production sender deliberately ignores one.
6. After source eligibility and token checks, update only Vladimir's disabled integration to the new Dataset, deploy the exact approved backend SHA while Meta sending remains off, and verify booking-host attribution handling is live.
7. Prepare consent-gated browser tracking that preserves the old advertising Pixel during transition. If two Pixels are initialized, use `trackSingle` for each Lead/PageView and retain the same enquiry UUID as the new Pixel's browser/server Lead `event_id`; avoid broadcasting each event twice to both Pixels.
8. Enable the integration and Meta drain only after deployment/preflight and consent/attribution checks. No historical backfill is implied.
9. Verify real consented Lead delivery and deduplication, artist isolation, downstream qualified/paid-booking triggers, safe production logs and booking/CRM regression checks. Agree a non-disruptive CRM test method before inserting a test enquiry.
10. Switching active advertising is a separate planned step after these checks. New Dataset history starts separately; old Pixel event history is not migrated.

## Acceptance status

Provider receipt, browser/server deduplication, production CRM stage-event delivery, token custody and campaign optimization eligibility remain **unverified**. Local tests or a successful PR do not satisfy production acceptance.
