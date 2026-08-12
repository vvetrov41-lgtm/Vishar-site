# CRM click-path and readiness audit

- **Repository:** `vvetrov41-lgtm/Vishar-site`
- **Branch:** `agent/multi-artist-payments-foundation`
- **Original audit date:** 2026-08-03
- **Owner device audit:** 2026-08-04
- **Post-audit UI polish update:** 2026-08-04
- **Retained-staging deployed implementation head:** `8ea7724df6f62a7ba14681d41ee8db4103940455`
- **Retained staging workflow:** `PR 177 retained staging resume and E2E`
- **Retained staging run:** `30884006932`
- **Related decision:** `docs/crm/adr/0001-responsive-navigation-and-artist-scope.md`
- **Audit type:** source, automated interaction, hosted staging and owner-attested responsive-device audit

This document records the resolved click-path findings, the UI defects found during the real-device pass and their source fixes. The post-audit UI fixes are not described as staging-verified until a separately authorised retained-staging redeployment and focused recheck are completed. The Cloudflare control plane is also not described as independently reviewed because the available deployment token could not read Access policy contents or Rulesets configuration.

## Scope

### Roles

- owner;
- booking manager;
- read only.

### Responsive surfaces

- iPhone Safari portrait;
- iPad Safari landscape, after the iPhone pass showed no P0 blocker;
- automated narrow-mobile and wide-layout coverage in the CRM test suite.

### Critical tasks

- select artist context;
- review, assign and progress an enquiry;
- convert an enquiry into a project;
- open a shared client and related records;
- plan and progress a session;
- reach owner administration according to capability;
- return safely from detail routes;
- avoid accidental consequential actions.

## Current navigation and scope model

### Mobile primary destinations

1. Dashboard
2. Enquiries
3. Sessions
4. Clients
5. More

The bottom navigation remains capped at five actions.

### Mobile overflow

Destinations are grouped after capability filtering:

- **Operations:** Projects and Activity where permitted;
- **Finance:** reserved for later Finance and Payments routes;
- **Administration:** Users and future administration routes.

Empty groups are not rendered. Finance is not exposed because its route scope and click paths have not been separately approved.

### Page scope

- **Artist-scoped:** Dashboard, Enquiries, Projects, Sessions and Activity.
- **Shared:** Clients and client details.
- **Global:** Users and other administration that does not consume artist scope.

Shared and global pages show explicit context instead of a misleading artist selector. The selector remains a usability filter; RLS and workflow RPC authorization remain authoritative.

### Detail routes

- `/enquiries/:id`;
- `/clients/:id`;
- `/projects/:id`.

Enquiry, client and project details include stable contextual return links. Enquiry and project details show their record artist and explain selected-filter mismatches without silently changing the global filter.

## Original P1 findings — completion status

### P1.1 Artist-scope applicability was ambiguous — complete

- The selector is shown only on artist-scoped pages.
- Clients show a shared-record notice.
- Users show a global-section notice.
- No UI fallback widens database access.

### P1.2 Detail routes could conflict with selected scope — complete

- Enquiry and project details show the record artist.
- Selected-scope mismatch is explicit.
- The user may deliberately switch the filter to the record artist.

### P1.3 Critical enquiry actions were buried — complete

- Status transitions, assignment and conversion are grouped above long contact, project and image content.

### P1.4 Detail pages lacked contextual return — complete

- Enquiry, client and project details provide stable collection links independent of browser history.

### P1.5 Dashboard operational rows were dead ends — complete

- Upcoming sessions and overdue follow-ups open their available project, enquiry or client context.

### P1.6 More lacked a complete modal lifecycle — complete in source and automated evidence

- Focus enters the sheet.
- Tab and Shift+Tab remain within it.
- Escape and backdrop dismiss it.
- Background scrolling is locked.
- Explicit dismissal restores focus to the More trigger.

The owner-attested pass visually confirmed the sheet layout, backdrop and usable controls. Keyboard focus trapping cannot be independently demonstrated by touch-device screenshots, so the detailed focus lifecycle continues to rely on automated interaction tests.

### P1.7 Artist-scope loading failure was silent — complete

- Artist-list failure is exposed without widening visible data.

## Original P2 findings — completion status

### P2.1 Explicit mobile primary order — complete

The required order is implemented and visible on both audited device classes.

### P2.2 Group overflow destinations — complete

Operations and Administration are grouped; empty groups are omitted.

### P2.3 Debounced enquiry and client search — complete

- `300ms` debounce;
- pending intermediate requests are cancelled;
- search text is trimmed before querying;
- status and artist filters remain independent.

### P2.4 Shared-client artist relationships — complete

- Client rows and details show deduplicated artists derived from accessible enquiries and projects.
- Clients remain shared records and do not receive `clients.artist_id`.

### P2.5 Session-duration shortcuts and conflict feedback — complete

- `3`, `5` and `7` hour shortcuts are available.
- End time is calculated from the selected local start time.
- Conflict detection includes accessible `draft`, `proposed` and `confirmed` sessions for the same artist, including other projects.
- `cancelled`, `completed` and `no_show` sessions are excluded.
- The warning is advisory and does not block an intentional overlap.

Owner-attested evidence confirmed a warning for a proposed `13 Aug 2026 09:40–16:40` session overlapping a confirmed Vladimir session beginning at `09:38`.

### P2.6 Consequential confirmations — complete

Confirmation is required before:

- enquiry-to-project conversion;
- session cancellation;
- no-show recording;
- user deactivation.

The original device audit confirmed that the browser-native prompts prevented mutation when declined. The post-audit source update replaces those hostname-labelled prompts with a CRM-owned accessible modal while preserving the same database-independent confirmation boundary.

## Automated and hosted evidence before the UI polish update

Normal CI completed successfully for `8ea7724df6f62a7ba14681d41ee8db4103940455`:

- Static Validation: run `30861147441`, passed;
- CRM and booking validation: run `30861147414`, passed;
- Public site and Worker validation: passed;
- dependency audits: zero reported vulnerabilities;
- repository secret scan: passed;
- Private CRM: 13 test files, 108/108 tests passed;
- TypeScript typecheck: passed;
- production CRM build: passed;
- clean Supabase reset with migrations `0001–0025`: passed;
- pgTAP: 933/933 passed;
- PostgreSQL error-level lint: passed.

The guarded retained-staging workflow `30884006932` completed successfully against that exact SHA. It confirmed migrations `0001–0025` without reapplying them and passed hosted artist routing, role scope, RLS, private Storage, Activity Log, exact-origin CORS, wrong-origin rejection, WAF path/method probes, rate-limit/recovery probes and staging-retention guards.

The post-audit UI polish commit must have both normal workflows green at its exact final PR head before it is eligible for a separately authorised retained-staging continuation.

## Owner-attested responsive-device audit

The owner completed the authenticated pass through the canonical CRM staging hostname with Cloudflare Access and CRM owner authentication active. Only synthetic retained-staging records were used.

### iPhone Safari portrait

The initial pass found no P0 or P1 defect. It covered:

- Dashboard layout and bottom-navigation order;
- Enquiries list and detail;
- record-artist context and artist selector options;
- action-first enquiry controls;
- stable return controls;
- shared Clients context and artist relationships;
- Projects detail and session planner;
- Sessions list;
- Activity layout;
- More sheet layout;
- global Users context with no artist selector;
- `3/5/7` hour shortcuts;
- same-artist conflict warning;
- conversion and session-cancellation confirmation boundaries;
- horizontal overflow, label clipping, tap targets and bottom-navigation overlap.

### iPad Safari landscape

The initial pass found no P0 or P1 defect. It covered Projects, Sessions and Clients wide layouts, the artist selector, bottom navigation, cards and empty states.

Screenshots containing the owner's personal email or browser/authentication context must not be attached to public PR evidence. The result is owner-attested rather than an independent agent-executed browser audit.

## Post-audit UI findings and source fixes

### Session duration differed between views — fixed in source

The Sessions page displayed `7 h` while the corresponding Project session card displayed an ambiguous dash. Project detail now renders `duration_hours` consistently. A missing finance price is omitted instead of being represented by a dash beside the session metadata.

### Technical event and integration identifiers were exposed — fixed in source

Known activity event types, integration job kinds and safe error codes now receive explicit English and Russian labels. The Activity filter is a localised select while still applying the exact raw event key server-side. Unknown future values fall back to readable text without punctuation separators.

### Repeated integration failures dominated Dashboard — fixed in source

Failed outbox rows are grouped by integration kind and safe error code. Each group shows a localised label, count, latest attempt state and latest timestamp instead of one large card per identical failure.

### Browser-native confirmations exposed the staging hostname — fixed in source

Consequential actions now use a CRM-owned `alertdialog` with:

- action-specific heading and button copy;
- English and Russian text;
- an explicit safe back action;
- destructive styling where appropriate;
- Escape and backdrop dismissal;
- page-scroll locking and restoration;
- focus placed inside the dialog.

RPC authorization and RLS remain authoritative. Declining the dialog prevents the RPC from being sent.

### Regression coverage added

Automated tests cover:

- Project session duration display;
- operational EN/RU labels and readable fallback;
- grouping repeated failed jobs and retaining the latest attempt;
- asynchronous consequential confirmations;
- the CRM-owned modal's accessible name, safe cancel path and scroll restoration.

## Readiness determination

### Source readiness

The four defects found during the owner visual audit are fixed in source. Final source readiness depends on both normal workflows passing at the exact final PR head.

### Device readiness

The original owner-attested iPhone and iPad audit remains valid for the unchanged navigation and workflow structure. A focused recheck is still required after the UI polish is deployed to retained staging, limited to:

- one Project session card showing duration;
- grouped and localised Dashboard failures;
- localised Activity labels/filter;
- one consequential CRM modal on iPhone portrait;
- a quick iPad landscape smoke check for the changed surfaces.

This recheck must not be described as complete before the new source head is actually deployed.

### Cloudflare control-plane evidence

**Incomplete.**

Live edge probes passed for Access redirects, exact-origin CORS, wrong-origin rejection, WAF path/method enforcement, rate limiting and recovery, and disabled `workers.dev` behaviour. However, the available deployment token could not independently read:

- Cloudflare Access application and policy contents;
- WAF Rulesets configuration;
- rate-limit Rulesets configuration.

Do not infer that a policy or rule is missing from a permission failure. Complete independent security sign-off still requires suitable read-only Cloudflare control-plane access or a separate owner-reviewed configuration record. Live probes do not replace that review.

## Retained staging and safety state

- retained Supabase project: `vishar-crm-staging`;
- retained migrations: `0001–0025`;
- retained Worker: `tattooai-preview`;
- deployed Worker version before the UI polish: `f756142c-e6c3-4f7c-b297-4ec239c114b3`;
- Booking Pages and CRM Pages remain staging-only;
- production unchanged;
- PR #174, PR #176 and PR #177 remain open, draft and unmerged;
- staging retained;
- synthetic data only;
- no production provider or payment connection was added;
- no RLS, RPC authorization, ACL, Storage policy, Access, WAF, rate-limit or CORS control was weakened.

The owner device audit created and changed synthetic project and session state while testing confirmation and conflict behaviour. It did not introduce real client data.

## Remaining evidence gaps

1. Both normal workflows must pass at the exact final UI-polish PR head.
2. Retained staging must not be redeployed until the owner separately authorises the guarded continuation workflow.
3. After that deployment, the focused device recheck listed above must be completed.
4. Cloudflare control-plane contents still require a read-only independent or owner-documented review.

## Deferred product work

The following remains outside this PR scope:

- Finance or Payments routes before separate scope and click-path approval;
- real payment provider and webhook connection;
- Google Calendar or Gmail OAuth;
- automatic reminders;
- production Telegram routing for Kristina;
- production GPT identities or tools;
- a dedicated session detail route without a separate architecture decision;
- appointment-type architecture for:
  - tattoo session;
  - in-person consultation;
  - video consultation;
  - touch-up.

The appointment-type stage should be designed separately because consultations may exist before a project. A future model should allow an appointment to reference an enquiry or client and optionally a project, while keeping artist conflict detection authoritative across all appointment types.

## Safety constraints

This post-audit source update does not deploy production or staging, mutate retained Supabase data, apply migrations, change DNS, alter Worker bindings, or modify Cloudflare controls.
