# CRM click-path and readiness audit

- **Repository:** `vvetrov41-lgtm/Vishar-site`
- **Branch:** `agent/multi-artist-payments-foundation`
- **Original audit date:** 2026-08-03
- **Readiness update:** 2026-08-04
- **Original audited head:** `c78f03dad0388f5ad5471b141b5cc0b193fcd99b`
- **Implementation head reviewed for this update:** `0fa435a65e6b93dd708b2a5e22be40e77c42bbf2`
- **Last successfully deployed retained-staging head:** `fee84a811334b46dcb2e8281706e61a0ae1bf889`
- **Related decision:** `docs/crm/adr/0001-responsive-navigation-and-artist-scope.md`
- **Audit type:** source, route, automated interaction and deployment-readiness audit

This document records the original click-path findings and their implementation status. It does not claim that a real authenticated iPhone or iPad Safari pass has been completed.

## Scope

### Roles

- owner;
- booking manager;
- read only.

### Responsive surfaces

- narrow mobile: `320–380px`;
- phone and portrait tablet: below `900px`;
- wide tablet and desktop: `900px` and above.

### Critical tasks

- select artist context;
- review, assign and progress an enquiry;
- convert an enquiry into a project;
- open a shared client and related records;
- schedule and progress a session;
- reach owner administration according to capability;
- return safely from detail routes;
- avoid accidental consequential actions.

## Current navigation model

### Mobile primary destinations

The order is explicit and no longer inherited from desktop navigation:

1. Dashboard
2. Enquiries
3. Sessions
4. Clients
5. More

The bottom navigation remains capped at five actions.

### Mobile overflow

Visible destinations are grouped after capability filtering:

- **Operations:** Projects, Activity where permitted;
- **Finance:** reserved for future Finance and Payments routes;
- **Administration:** Users and future Integrations or Settings routes.

Empty groups are not rendered. Finance is not exposed because its route scope and click paths have not yet been approved.

### Page scope

- **Artist-scoped:** Dashboard, Enquiries, Projects, Sessions and Activity.
- **Shared:** Clients and client details.
- **Global:** Users and other administration that does not consume artist scope.

Shared and global pages show explicit context instead of a misleading artist selector.

### Detail routes

- `/enquiries/:id`;
- `/clients/:id`;
- `/projects/:id`.

Enquiry, client and project details include a stable contextual return link. Enquiry and project details are record-authoritative: they show the record artist and explain a mismatch with the selected global filter.

## Original P1 findings — completion status

### P1.1 Artist-scope applicability was ambiguous — complete

- The selector is shown only on artist-scoped pages.
- Clients show a shared-record notice.
- Users and global administration show a global-section notice.
- UI scope remains a convenience filter; RLS remains authoritative.

### P1.2 Detail routes could conflict with selected scope — complete

- Enquiry and project details show the record artist.
- A selected-scope mismatch is explicit.
- The user can deliberately switch the global filter to the record artist.
- An inaccessible artist remains record-authoritative and does not weaken database access control.

### P1.3 Critical enquiry actions were buried — complete

- Status transitions, assignment and conversion are grouped near the top of enquiry detail.
- Long contact, project and reference-image content remains below the action area.
- Eligible conversion still depends on role, intake state and enquiry status.

### P1.4 Detail pages lacked contextual return — complete

- Enquiry, client and project details have stable links back to their parent collections.
- The links do not depend on browser history.
- The return control has a minimum `44px` target.

### P1.5 Dashboard operational rows were dead ends — complete

- Upcoming confirmed sessions open their project context.
- Overdue follow-ups open the enquiry, project or client they reference.
- Unlinked follow-ups remain non-interactive rather than navigating to an invented target.

### P1.6 More lacked a complete modal focus lifecycle — complete

- Focus enters the sheet on open.
- Tab and Shift+Tab remain within the sheet.
- Escape and backdrop interaction dismiss it.
- Background scrolling is locked while open.
- Explicit dismissal restores focus to the More trigger.
- Route navigation does not force focus back to the old trigger.

### P1.7 Artist-scope loading failure was silent — complete

- Artist-list failure is exposed as a compact alert.
- The message states that database access controls remain authoritative.
- No fallback widens visible data.

## Original P2 findings — completion status

### P2.1 Explicit mobile primary order — complete

The target order is implemented and covered by an automated navigation test.

### P2.2 Group overflow destinations — complete

Operations, Finance and Administration groups are defined. Empty groups are omitted for restricted roles.

### P2.3 Debounce enquiry and client search — complete

- Search inputs remain controlled and responsive.
- Queries wait `300ms` after typing settles.
- Pending intermediate requests are cancelled.
- Search values are trimmed before querying.
- Status and artist filters continue to apply independently.

### P2.4 Show artist relationships on shared clients — complete

- Client rows show artists linked through accessible enquiries and projects.
- Client details show a deduplicated relationship summary.
- Related enquiry and project rows show their record artist.
- Clients remain shared and are not filtered by the selected artist.
- Relationships are derived only from rows visible through existing RLS.

### P2.5 Add session-duration shortcuts and conflict feedback — complete

- Session planning provides `3`, `5` and `7` hour shortcuts.
- The end time is calculated from the selected local start time.
- Conflict detection checks accessible sessions for the same artist, including other projects.
- `draft`, `proposed` and `confirmed` sessions can conflict.
- `cancelled`, `completed` and `no_show` sessions do not conflict.
- Conflict feedback is advisory and does not block an intentional overlap.

A dedicated session detail route remains deferred. The present project-level session workflow is sufficient for this stage and does not justify a new route without a separate architecture decision.

### P2.6 Confirm consequential actions — complete

Confirmation is required before:

- converting an enquiry into a project;
- cancelling a session;
- recording a no-show;
- deactivating a user.

Declining confirmation prevents the RPC from being sent. Ordinary workflow actions are not interrupted. Confirmation copy follows the selected English or Russian CRM language.

This confirmation boundary is a user-safety control, not authorization. Database RPC checks and RLS remain authoritative.

## Automated evidence at implementation head

Normal CI completed successfully for `0fa435a65e6b93dd708b2a5e22be40e77c42bbf2`:

- Static Validation: passed;
- CRM and booking validation: passed;
- Public site and Worker: passed;
- dependency audits: zero reported vulnerabilities;
- Private CRM: 13 test files, 108/108 tests passed;
- TypeScript typecheck: passed;
- production CRM build: passed;
- clean Supabase reset with migrations `0001–0025`: passed;
- pgTAP: 933/933 passed;
- PostgreSQL error-level lint: passed.

The documentation-only readiness commit must also have both normal workflows green before it can be used as an approved staging SHA.

## Retained staging delta

Retained staging was last successfully deployed from:

`fee84a811334b46dcb2e8281706e61a0ae1bf889`

The reviewed implementation head is 28 commits ahead. The deployable delta is limited to CRM UI, tests and a narrow dependency override. It includes:

- grouped More navigation;
- debounced list search;
- shared-client artist context;
- consequential-action confirmations;
- session duration shortcuts and conflict feedback;
- associated tests;
- `undici` lockfile override used to keep dependency audit green.

There are no new migrations after `0025` and no production configuration changes in this delta.

## Readiness determination

### Source readiness

**Ready for another isolated retained-staging deployment.**

No P0 or unresolved P1/P2 source blocker remains in the audited click paths. Normal CI is green at the reviewed implementation head.

### Correct deployment path

Hosted staging already contains migrations `0001–0025`. Therefore the initial full migration workflow must not be used as though staging were still at migration `0014`.

The correct path is the guarded post-gate continuation workflow:

- workflow: `PR 177 retained staging resume and E2E`;
- exact PR head only;
- PR must remain open, draft and unmerged;
- both normal workflows must be completed successfully for that exact SHA;
- hosted migration precondition must confirm exactly `0001–0025`;
- owner review confirmation must be exactly `CONTINUE PR177 AFTER HOSTED GATE`.

The workflow may redeploy the preview Worker and both staging Pages artifacts, but it targets retained staging only and does not target production.

## Remaining evidence gaps

These are not source blockers for a repeat staging deployment, but they prevent complete final sign-off.

### 1. Latest UI delta is not deployed to retained staging

The current UI improvements exist only on the PR branch and branch preview until the guarded continuation is run against the final green head.

### 2. Authenticated iPhone/iPad Safari audit is not complete

The attempted manual pass stopped at Cloudflare Access because an authorized owner browser session was unavailable. At the user's direction, that stage was deferred.

No real-device defect was found because the CRM itself was not reached. The audit must not be described as passed or failed.

A future device pass should use the canonical CRM staging hostname with Cloudflare Access and CRM owner authentication active. It should not require disabling WAF, RLS, Storage policies, ACLs or CRM authentication.

### 3. Edge control-plane evidence remains partial

Earlier live staging probes passed for canonical Access redirects, exact-origin CORS, wrong-origin rejection, exact WAF path and method enforcement, rate limiting and recovery, and disabled `workers.dev`.

The deployment token did not independently read Cloudflare Access policy contents or Rulesets configuration. Complete security sign-off therefore still requires either suitable read-only control-plane access or a separate owner-verified configuration review. Live probes do not replace that review.

## Post-deploy acceptance checks

After the guarded continuation succeeds, verify:

1. the deployed evidence names the exact approved PR head;
2. canonical CRM and booking staging domains resolve to the new Pages deployments;
3. hosted E2E still passes artist routing, role scope, RLS, Storage, Activity Log and edge probes;
4. CRM build evidence reports all current tests passing;
5. one authenticated iPhone portrait pass covers primary navigation, More, artist scope, enquiry detail, shared client context and session planning;
6. one authenticated iPad landscape pass follows only when there is no iPhone P0 blocker;
7. Cloudflare Access remains enabled after testing;
8. production remains unchanged;
9. PR #174, #176 and #177 remain open, draft and unmerged;
10. staging remains retained and contains synthetic data only.

## Deferred product work

The following is outside this click-path completion pass:

- Finance or Payments routes before their scope and click paths are documented;
- real payment provider connection;
- Google Calendar or Gmail OAuth;
- automatic client reminders;
- production Telegram routing for Kristina;
- production GPT identities or tools;
- a session detail route without a separate architecture justification.

## Safety constraints

This readiness audit changes documentation only. It does not alter production, hosted Supabase, staging data, RLS, ACLs, Storage policies, Cloudflare Access, WAF, rate limiting, DNS, Worker bindings or provider credentials.
