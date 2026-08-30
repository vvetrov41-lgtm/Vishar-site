# Vishar CRM — UX/UI Audit

**Audit date:** 2026-08-30
**Audited revision:** `b0c2a32dbfceea0752b3b9f7474c8b545ea3642f` — `release/private-crm-rc530-whatsapp-meta-secret-url-hardening` (2026-08-30 16:19 +0100), the newest CRM release branch at time of audit.
**Audited source:** `admin/` (React 18 + TypeScript + Vite, hash router, Supabase browser client). The CRM does **not** exist on `main`; it lives only on `release/private-crm-rc*` branches.
**Method:** full source read of `admin/src` (22,564 lines across 92 source files), plus `docs/crm/`. All file references below are `admin/`-relative at the audited SHA.

## Production access statement

**No production CRM instance was accessed.** Per `AGENTS.md` this is stated explicitly rather than assumed:

- `docs/crm/DEPLOYMENT.md:26` records the CRM host as `admin.vishartattoo.com` **"or other approved host, not created"**, and `docs/crm/DEPLOYMENT.md:245` records that Cloudflare Access is owner-only on the Pages projects.
- `admin/README.md:11-13` states "Nothing here is deployed."
- The `cloudflare-api` MCP server requires interactive OAuth, which is unavailable in this session.

Consequently every finding below is derived from the source that the production build is produced from (`.github/workflows/deploy-private-production-crm.yml` builds `admin/` and deploys `admin/dist` only). Findings marked **requires production URL** could not be confirmed against a running instance: rendered contrast values, real device keyboard behaviour, actual data volumes, and perceived load times. No Lighthouse, GA4, or Search Console result is claimed.

An earlier audit exists at `docs/crm/CLICK-PATH-AUDIT-2026-08-03.md`. It covered navigation *mechanics* (scope model, overflow sheet lifecycle, focus handling) and is largely still accurate. This audit covers *task efficiency and information architecture*, which that audit did not, and it records one regression against it (Finding 16).

---

## Executive summary

The CRM is technically well built. It is genuinely mobile-first, the permission model is honest, empty and error states exist everywhere, the artist-scope concept is coherent, and the code is unusually well commented about its own intent. Nothing here is a rescue job.

The problem is different: **the CRM is organised around its database tables, not around the client.** Nine of the ten most common daily actions require the operator to hold the CRM's internal entity graph in their head. The single clearest symptom is that **you cannot see a client's name on the enquiries list, the projects list, the dashboard's upcoming sessions, or the project page.** The operator's mental model is "Diana, half sleeve, deposit paid, Tuesday." The CRM's model is "ENQ-2026-0143 → project → appointment → payment_request → reconciliation_candidate", and it makes the operator do the join.

The ten most important findings:

1. **The enquiries queue never shows who the enquiry is from.** Rows show `ENQ-2026-…`, a status badge and a project type (`EnquiriesPage.tsx:325-338`). Identifying a new enquiry costs one navigation per enquiry.
2. **Client search matches the full name only** (`api.ts:307`, `.ilike('full_name', …)`). Phone, email and Instagram — the three identifiers a message actually arrives with — return nothing.
3. **The Payments screen is unreachable from a cold start.** It refuses to render without a selected artist (`PaymentsPage.tsx:513-516`), but the artist selector is deliberately hidden on that route (`AppShell.tsx:481-496` classifies `/payments` as `global`). The user is told to choose an artist on a screen that offers no way to choose one. **P0.**
4. **The client page cannot answer the questions it exists to answer.** It has no appointments, no payments, no messages, and no follow-ups (`ClientDetailPage.tsx:55-129`). "When is their next session?" and "did they pay?" are not answerable from the client.
5. **There is no "today" anywhere in the CRM.** The string exists once, as a follow-up due label (`format.ts:62,68`). There is no calendar view, no day view, and no agenda. Appointments is a flat upcoming/past list.
6. **Messaging is split across three surfaces for two of four channels.** The Inbox covers WhatsApp and Instagram only (`communications-api.ts:10`); the Email tab is a hard-coded empty list plus an apology (`InboxPage.tsx:89,157-159`); and the enquiry page carries a *second, different* WhatsApp thread UI (`EnquiryWhatsAppPanel.tsx:132-181`).
7. **On mobile, Clients and Communications are not in the tab bar.** The five thumb slots are Dashboard, Enquiries, Appointments, Projects, More (`AppShell.tsx:35`). Replying to a client — the most frequent daily act — starts with "More".
8. **Deposit matching is a 5-step commit for a match the server already made.** The correct option is pre-selected (`PaymentsPage.tsx:204-213`) and still requires open → verify → Match → Confirm → dismiss a native `confirm()`.
9. **Every API error message in the CRM is English-only** — roughly 70 hard-coded strings (`api.ts:72-81` and siblings). In Russian the error title translates and the sentence beneath it does not.
10. **Two conflict-checking behaviours contradict each other.** Booking a consultation *blocks* on a clash (`EnquiryConsultationPanel.tsx:49-52`); booking a tattoo session only *warns* and lets you proceed (`ProjectDetailPage.tsx:505`, `AppointmentsPage.tsx`). The safer path is on the lower-stakes action.

The good news is that findings 1, 2, 4 and 7 are small, contained changes with disproportionate effect. A focused Phase 1 of roughly two weeks would remove most of the daily friction without touching the data model.

---

## Current UX score

Scored 1–10 for a tattoo artist using this daily. Each score is justified by specific evidence.

| Area | Score | Justification |
|---|---|---|
| **Navigation** | 5/10 | Structure is clean and the mobile overflow sheet is properly built (focus trap, Escape, scroll lock — `AppShell.tsx:103-157`). But 13 primary destinations for a two-person studio is too many, four of them (`/availability`, `/automations`, `/activity`, `/notifications`) are rarely-touched configuration, and the two highest-frequency destinations are excluded from the mobile tab bar (`AppShell.tsx:35`). `Back` always returns to the section root regardless of where you came from (`DetailContext.tsx:5-22`). |
| **Information architecture** | 3/10 | Six entities (Enquiry, Client, Project, Appointment, Payment request, Reconciliation candidate) are all exposed as first-class UI objects. The operator must know that a consultation attaches to an enquiry but a tattoo session requires a project (`AppointmentsPage.tsx:141-146`), and that a deposit is a "payment request" matched to a "reconciliation candidate". A raw UUID prefix is printed in the payments UI (`PaymentsPage.tsx:821`). |
| **Client workflow** | 3/10 | The client page shows identity, enquiries, projects and notes — and nothing else. No bookings, no payments, no messages, no next action (`ClientDetailPage.tsx:55-129`). Search is name-only (`api.ts:307`). Finding a client by the phone number they just messaged from is impossible. |
| **Booking workflow** | 4/10 | Real strengths: live conflict checking, duration shortcuts, explicit calendar-sync status per appointment. Weaknesses: two `datetime-local` fields instead of a date plus duration; no calendar to pick from; booking is a `<details>` disclosure on the project page (`ProjectDetailPage.tsx:299-300`); new appointments land as `proposed` and need a separate Confirm click; the create form sits above the schedule on `/appointments`. |
| **Messaging** | 4/10 | The Inbox itself is good — one list, channel as a badge, unread state, unmatched filter, and a genuinely thoughtful "an inbound DM is not an enquiry" rule (`ConversationPage.tsx:4-9`). But it covers 2 of 4 channels, Email is a dead tab, WhatsApp has a second UI on the enquiry page, and while replying you cannot see whether the client has a booking or has paid. |
| **Payments** | 2/10 | The cold-start deadlock (Finding 3) alone caps this. Beyond it: deposit-eligible appointments are listed by date with no client name (`PaymentsPage.tsx:757-786`), matching is a 5-step commit, a UUID fragment is shown to the user, and one heading is untranslated in both languages (`PaymentsPage.tsx:796`). |
| **Mobile usability** | 6/10 | The best-executed area. Genuinely mobile-first: `--tap: 44px` applied to inputs, buttons and rows (`styles.css:20,317,360,371`), a fixed tab bar with `env(safe-area-inset-bottom)` (`styles.css:186-199`), `min-width: 0` discipline throughout to stop long names blowing out layouts. Held back by badge-links at roughly 20px tall (`styles.css:327-336`), a 200-option native client picker (`AppointmentsPage.tsx:281-291`), and the tab-bar composition problem. |
| **Visual hierarchy** | 4/10 | Badge saturation is the core issue: an appointment row can render nine badges (`AppointmentsPage.tsx:~430-470`) at uniform size and weight, so nothing reads as more important than anything else. Every screen is a vertical stack of visually identical `.card` sections with no primary-action emphasis. |
| **Consistency** | 4/10 | Two confirmation systems (a well-built CRM dialog for 8 RPCs, plus 10 raw `window.confirm` sites); two conflict policies; two WhatsApp UIs; two localisation systems (central `i18n` plus 13 local `COPY` dictionaries); two "hidden section" idioms (`<details>` and a boolean toggle). |
| **Localization** | 5/10 | The central dictionary is complete and disciplined — 281 EN keys, 281 RU keys, zero drift (verified by key diff), with correct Russian plural handling (`DashboardPage.tsx:197-210`). All the damage is *outside* it: ~70 English-only API errors, two nav items falling through to their English key, and one literally untranslated heading. |
| **Overall usability** | 4/10 | Sound engineering, wrong organising principle. A competent operator will be productive, but they will pay a per-task tax that the CRM could remove without a rewrite. |

---

## Top 10 UX problems

| # | Priority | Area | Problem | User impact | Recommended change | Impact / Effort |
|---|---|---|---|---|---|---|
| 1 | **P0** | Payments | `/payments` requires a selected artist but hides the artist selector on that route (`PaymentsPage.tsx:513-516` + `AppShell.tsx:481-496`, default is `null` per `artist-scope.tsx:52`) | A first-time or post-logout user sees "Choose one artist to manage payments" with no control to do so. Deposits cannot be requested or matched until they discover the workaround: visit Enquiries, set the artist, return. | Classify `/payments` as `artist` scope so the selector renders; additionally render an in-page artist chooser in the empty state instead of a bare instruction | High / **Small** |
| 2 | **P0** | Payments | Deposit-eligible appointment rows show date + status + amount but **no client name** (`PaymentsPage.tsx:757-786`); the grouped-session list shows a UUID prefix instead (`PaymentsPage.tsx:821`) | The operator sends a payment request chosen by date alone. Two clients on the same day means a real risk of requesting the wrong person's deposit. | Render client name as the row title, date as the subtitle; delete the UUID fragment | High / **Small** |
| 3 | **P1** | Enquiries | The queue shows `reference_number` only; no client name is fetched (`EnquiriesPage.tsx:325-338`, `api.ts:228`) and search matches `reference_number` only (`api.ts:240`) | Triaging five new enquiries costs five round-trips. Finding "that enquiry from Anna" is not possible without opening them one by one. | Join client name into the enquiry list query; make the row title `{client name} · {project type}` with the reference as secondary; extend search to name/email/phone | High / **Small** |
| 4 | **P1** | Clients | Client search is `.ilike('full_name', …)` only (`api.ts:307`) | A WhatsApp message arrives from +44 7700 900123. Searching that number returns nothing. The operator scrolls a 200-row list or gives up. | Extend to `or(full_name.ilike, email.ilike, phone.ilike, instagram.ilike)` with normalised phone matching (`phone.ts` already exists) | High / **Small** |
| 5 | **P1** | Client page | No bookings, payments, messages or follow-ups on the client (`ClientDetailPage.tsx:55-129`) | The five questions asked about every client before replying require four separate screens. | Add a "Right now" header block (next appointment, deposit state, last message, open follow-up) plus a unified timeline — see *Proposed client workspace* | High / **Medium** |
| 6 | **P1** | Daily workflow | No "today" concept and no calendar view anywhere; the Dashboard's upcoming-session rows show a date, a status badge and a duration, with no client name, and link to the *project* (`DashboardPage.tsx:82-90`) | The first question of the day — "who am I seeing today?" — is unanswerable at a glance. | Replace the Dashboard with a Today screen: today's appointments *with client names*, then things awaiting a reply, then overdue follow-ups | High / **Medium** |
| 7 | **P1** | Mobile nav | Tab bar is Dashboard / Enquiries / Appointments / Projects / More (`AppShell.tsx:35`); Clients and Communications sit in the overflow sheet | The two most frequent destinations cost an extra tap and a modal, every time. | Tab bar → Today / Inbox / Clients / Calendar / More. Projects is reached from a client, which is how it is actually used. | High / **Small** |
| 8 | **P1** | Payments | Matching a suggested payment takes 5 interactions despite the correct option being pre-selected (`PaymentsPage.tsx:204-213, 934-966`) | The most repetitive finance action is the slowest. | When `suggested_payment_request` exists, render one sentence and one **Confirm £X from {name}** button; keep Change and Ignore as secondary | High / **Small** |
| 9 | **P1** | Messaging | Inbox covers WhatsApp + Instagram only (`communications-api.ts:10`); Email is a hard-coded empty tab (`InboxPage.tsx:89,157-159`); a second WhatsApp UI exists on the enquiry (`EnquiryWhatsAppPanel.tsx`) | "Has this client been answered?" has no single place to be asked. | Short term: remove the dead Email tab and replace the enquiry's WhatsApp panel with a link into the conversation. Longer term: bring Gmail threads into the same list. | High / **Medium** |
| 10 | **P1** | Booking | Consultation booking blocks on conflicts; session booking only warns (`EnquiryConsultationPanel.tsx:49-52` vs `ProjectDetailPage.tsx:505`) | Inconsistent safety. The operator cannot learn one rule. A double-booked tattoo session is far more costly than a double-booked consult, yet it is the permitted one. | One policy: warn clearly and require an explicit "book anyway" acknowledgement, on both | Medium / **Small** |

---

## Navigation audit

### Current structure

Sidebar (≥900px) and mobile tab bar are generated from the same list, `NAV_ITEMS` in `permissions.ts:193-210`, filtered by capability:

```
/            Dashboard
/inbox       Communications
/enquiries   Enquiries
/clients     Clients
/projects    Projects
/appointments Appointments
/availability Time off
/automations Automations
/payments    Payments
/integrations Integrations
/notifications Notifications
/users       Users
/activity    Activity
(+ /workspaces Organizations, appended from the server per AppShell.tsx:60-73)
```

Mobile takes four of these plus "More" (`AppShell.tsx:35`); the remainder is grouped into Operations / Finance / Administration in a bottom sheet (`AppShell.tsx:431-472`).

### Per-item assessment

| Item | Label understandable? | Belongs in primary nav? | Daily frequency | Overlap | Verdict |
|---|---|---|---|---|---|
| Dashboard | Yes, but generic | Yes — as **Today** | Every session | — | Rename and restructure around today |
| Communications | Partly — "Inbox" is the universal term | **Yes, on mobile too** | Many times daily | Duplicated by the enquiry WhatsApp panel | Promote; rename Inbox |
| Enquiries | Yes | Merge into Inbox | Daily | Heavy — a new enquiry *is* an inbound message | Fold in as an Inbox filter |
| Clients | Yes | **Yes, on mobile too** | Many times daily | — | Promote |
| Projects | Ambiguous — an artist says "piece" or "the sleeve" | No | Weekly | Project vs Booking is the CRM's distinction, not the user's | Demote; reach from client |
| Appointments | Yes | Yes — as **Calendar** | Daily | `/availability` is the same calendar with a different write | Merge Time off in |
| Time off | Yes | No | Monthly | Same domain as Appointments | Merge into Calendar |
| Automations | Understandable, rarely relevant | No | Rarely | Overlaps Follow-ups conceptually | Settings |
| Payments | Yes | Yes | Daily-ish | — | Keep; fix the deadlock |
| Integrations | Technical but honest | No | Setup only | — | Settings |
| Notifications | Yes | No | Occasional | Overlaps Today's "needs attention" | Fold into Today + a header bell |
| Users | Yes | No | Rarely | — | Settings |
| Activity | Vague — it is an audit log | **No — this is an internal entity** | Rarely | Duplicated by per-record activity logs | Settings → Audit log |
| Organizations | Control-plane concept | No | Rarely | — | Settings |

### Surface-by-surface

- **Sidebar** (`AppShell.tsx:161-186`): a flat 13-item list with no grouping, while the *mobile* sheet does group into Operations / Finance / Administration. The richer surface has the poorer structure. Apply the same grouping to the sidebar.
- **Mobile tab bar** (`AppShell.tsx:229-253`): correctly capped at five and correctly built (safe-area inset, 21px icons, `aria-current`). The composition is the problem, not the mechanics.
- **Header** (`AppShell.tsx:189-224`): shows "Vishar CRM" plus the active section name plus a profile menu plus a full-width artist-scope row. On a phone this is three stacked rows of chrome before any content. The brand text is redundant inside an installed app.
- **Breadcrumbs**: none. `DetailBackLink` (`DetailContext.tsx:5-22`) is a single link to the section root — so an appointment → client → "Back to Clients" drops the operator into a list they never came from.
- **Tabs**: none inside records. Everything is a long vertical stack of `.card` sections. On the enquiry page that is nine stacked sections.
- **Context menus**: none. Every action is a visible inline button, which is honest but contributes to the button density on list rows.
- **Modal navigation**: only the mobile More sheet and the consequential-action dialog. Both are well implemented.

### Depth patterns worth removing

Real paths in the current build:

- Book a consultation: `/enquiries` → open enquiry → scroll to the *Project* section → the consultation form is rendered by `EnquiryEditPanel` (`EnquiryEditPanel.tsx:82-84`) → type a datetime → Schedule. Booking lives inside a component named "edit panel", under a heading about the project, and **vanishes the moment you click "Edit enquiry"** (`EnquiryEditPanel.tsx:79-96`).
- Book a session: `/projects` → project → *Appointments* section → expand the `<details>` "Add another appointment" → type two datetimes → Propose → find the row → Confirm.
- Match a deposit: `/payments` → (set an artist elsewhere first) → scroll past Connection, Deposits, Catalogue, Policy, Request, Multiple Sessions → Reconciliation → dropdown → Match → Confirm → native dialog.

---

## Client workspace audit

### What the client page shows today (`ClientDetailPage.tsx`)

1. Back link to `/clients`
2. Identity card: name, email, phone, Instagram, preferred contact, travelling from, artist, first seen, an edit panel, and a merge notice
3. Enquiries — reference numbers, statuses, dates
4. Projects — titles, statuses, deposit badges
5. Internal notes

### What it cannot answer

| Question the operator has | Answerable here? |
|---|---|
| Who is this? | Yes |
| What do they want? | Only by opening an enquiry |
| What stage are they at? | Partly — per-enquiry and per-project badges, no overall state |
| When did we last speak? | **No** — no messages at all |
| What was promised? | **No** — follow-ups are not shown on the client |
| Has a deposit been paid? | Partly — a per-project badge, no amount unless you open the project |
| Is there a booking? | **No** — appointments are absent entirely |
| When is the next appointment? | **No** |
| What needs to happen next? | **No** |

Six of nine, unanswerable on the screen whose entire purpose is answering them. The identity block — nine definition rows, several usually `—` — occupies the most valuable space on the page, while the operationally urgent facts are absent.

### Should the tabs be tabs?

There are currently no tabs; there are stacked sections. Splitting them into Overview / Projects / Bookings / Messages / Payments / Files / Activity would be the wrong fix: it multiplies context switching for a page whose problem is that facts are *missing*, not that they are crowded. A single scrolling workspace with a dense fixed header is the better model for a phone.

### Proposed client workspace

**Block 1 — Status header (always visible, sticky on desktop).** One line of identity, one line of state:

> **Diana Didy** · +44 7700 900123 · @diana.d
> Next: **Tue 3 Sep, 11:00 — half sleeve, 5h** · Deposit **£150 paid** · Last message **2 days ago (WhatsApp)** · **1 follow-up overdue**

Every element is a link to the relevant place. This block alone answers eight of the nine questions.

**Block 2 — Next action.** One primary button reflecting actual state, not a row of equal-weight options: *Reply* if they are waiting on you; *Request deposit* if a session is booked and unpaid; *Book session* if the deposit is paid and nothing is scheduled; *Schedule follow-up* otherwise.

**Block 3 — Conversation.** The real message thread, inline, with a reply box. Not a link to another screen. This is where the operator spends their time.

**Block 4 — The work.** Enquiries and projects merged into one list of "things this client wants", each with stage, deposit state and next appointment on the row.

**Block 5 — Timeline.** Messages, bookings, payments, status changes and notes interleaved in one reverse-chronological stream. This replaces the separate notes and activity sections and removes the need for tabs.

**Block 6 — Details.** The current nine-row identity block, collapsed by default.

---

## Workflow audit

### Scenario A — New enquiry

**Path today:** `/enquiries` → row shows `ENQ-2026-0143 · new · unassigned · Sleeve · 2h ago` → open → nine stacked sections.

- *Is it clear what happened?* Only after opening. The list deliberately hides the person.
- *Is the next action obvious?* Partly. "Enquiry actions" is high on the page and only offers legal transitions (`permissions.ts:171-181`) — that is good design. But the transition buttons are unlabelled as to consequence: a row of status names with no indication which is the normal next step.
- *Is information scattered?* Yes. Client contact appears **three times** on one screen: the current client card, a collapsed "Submitted enquiry data" snapshot (`EnquiryDetailPage.tsx:224-234`), and the WhatsApp panel's phone requirement. This triplication is defensible — a mismatch between submitted and stored contact matters — but it is presented as three equal blocks rather than as one block with a diff warning.
- *Is hierarchy clear?* No. Nine `.card` sections of identical visual weight: header, actions, client, WhatsApp, project, references, follow-ups, notes, activity.
- *Is the client's state visible?* Status and intake badges yes; whether they are waiting on a reply, no.

**Friction:** identification requires navigation; reference images — the thing an artist actually judges the job on — are the sixth section down.

### Scenario B — Consultation

**Path today:** `/enquiries` → enquiry → scroll to Project → consultation form → pick type → type a datetime → pick duration → Schedule.

**Meaningful interactions: 6–7**, of which typing a datetime into a native `datetime-local` on a phone is the expensive one.

Specific problems:

- The form is rendered by `EnquiryEditPanel`, so it is **gated behind the `editEnquiry` capability** (`EnquiryEditPanel.tsx:36`) even though it independently checks `manageSessions` (`EnquiryEditPanel.tsx:82`). A role with session management but not enquiry editing loses consultation booking entirely. This is a capability-coupling defect, not just a layout one.
- Clicking "Edit enquiry" hides the consultation form.
- No availability is offered. The operator must already know when they are free — and `/availability` is a different screen.
- Conflicts block submission with "Choose another time" (`EnquiryConsultationPanel.tsx:49-52`), but no alternative is suggested.

**Target: 3 interactions** — from the client or enquiry, *Book consultation* → pick a slot from offered free slots → confirm.

### Scenario C — Tattoo booking

**Path today:** client → project → Appointments → expand `<details>` → type start → type end (or click a duration shortcut) → Propose → locate the new row → Confirm. Deposit is a separate section further down, or a different screen entirely.

**Where the operator can get lost or go wrong:**

- **Accidentally creating the wrong thing.** On `/appointments`, `tattoo_session` and `touch_up` require a project while consultations do not (`AppointmentsPage.tsx:141-146`). The rule surfaces only as a warning after you have already chosen a type.
- **Unsure whether it saved.** On success the form clears and the list reloads (`AppointmentsPage.tsx:169-173`). There is no confirmation message. The only evidence is a new row somewhere in a list.
- **Missing a conflict.** Conflicts are shown as `notice warn` with `role="status"` (polite, not assertive) and never block (`AppointmentsPage.tsx:~355-363`). It is entirely possible to double-book by not scrolling.
- **Forgetting the next step.** A `proposed` appointment needs a later Confirm. Nothing tracks that. It appears on no worklist — the Dashboard filters to `confirmed` only (`DashboardPage.tsx:55-57`), so proposed appointments are invisible until someone remembers.
- **The project page never shows the client's name** (`ProjectDetailPage.tsx:155-174`) — only the project title and an "Open client" badge. You book without seeing who you are booking.

### Scenario D — Deposit

**Intended:** money arrives → CRM recognises it → confirm.

**Actual:** `/payments` → (deadlock unless an artist was selected elsewhere) → scroll past six panels → Reconciliation → read `£150 · Suggested` → open a dropdown that is already correctly filled (`PaymentsPage.tsx:204-213`) → **Match** → the **Confirm payment** button appears → click it → dismiss a native `window.confirm` (`PaymentsPage.tsx:495-497`).

This is the clearest instance of the CRM's core problem. The user's model is "Diana paid her deposit." The interface requires understanding that a *reconciliation candidate* is being matched to a *payment request* which belongs to a *session* which belongs to a *project* which belongs to a client. The server already knows the answer and pre-selects it; the interface still charges five interactions to agree with it.

> **Before:** Payments → set artist elsewhere → scroll → open dropdown → Match → Confirm → native dialog *(6 steps)*
> **After:** Today screen shows *"£150 received from D DIDY — looks like Diana Didy's deposit for Tue 3 Sep. Confirm?"* → **Confirm** *(1 step)*

### Scenario E — Messaging

| Channel | Where it lives | Can you reply in CRM? |
|---|---|---|
| WhatsApp | `/inbox` **and** the enquiry page panel | Yes, in both — two different UIs |
| Instagram | `/inbox` | Yes |
| Gmail | Not in the Inbox; the tab returns `[]` and shows a notice (`InboxPage.tsx:89,157-159`) | Via enquiry email drafts |
| Telegram | Not a conversation channel at all — it is staff notification transport (`NotificationsPage.tsx:1-5`) | No |

- *Does it feel like one conversation?* For WhatsApp and Instagram, yes — and the Inbox is well designed for it. Across all channels, no.
- *Is it obvious where to reply?* No. For a WhatsApp client there are two valid places with different capabilities.
- *Does the user think about the technical channel?* Yes — they must know that email is somewhere else and Telegram is not a client channel.
- *Is the latest message easy to find?* Yes — sorted with an unread badge (`InboxPage.tsx:195-212`). Good.
- *Is it obvious who is waiting?* Partly — `has_unread` is shown, but there is no "you have not replied" state distinct from "unread".
- *Is client and project context visible while messaging?* **No.** `ConversationPage` shows a linked-client link, an enquiry link, history and a composer. No booking, no deposit, no stage. The operator replies blind and must open another screen to check.

Note one genuinely good decision worth preserving: inbound DMs are never auto-promoted to enquiries (`ConversationPage.tsx:4-9`). That is correct and well reasoned.

### Scenario F — Daily workflow

Opening the CRM, the Dashboard (`DashboardPage.tsx`) offers, in order: three enquiry counters (New / Unassigned / Waiting); upcoming **confirmed** sessions; overdue follow-ups; failed integration jobs; recent activity.

Against the morning checklist:

| Needed within 5–10 seconds | Available? |
|---|---|
| Today's appointments | **No.** The list is "next 5 confirmed, ever" (`DashboardPage.tsx:55-57`) with no day boundary — and each row shows only a date, a status badge and a duration. **No client name.** |
| New enquiries | A count only. Acting on it means going to another screen. |
| Unanswered messages | **No.** The Dashboard does not touch the Inbox at all. |
| Unpaid deposits | **No.** Nothing from Payments appears. |
| Clients needing a reply | **No.** |
| Overdue follow-ups | **Yes** — the one thing this screen does properly, with correct links (`DashboardPage.tsx:190-195`). |
| Integration problems | Yes, if `viewIntegrationJobs` — sensibly grouped (`operational-labels.ts`). |
| Booking changes | Partly. `client_response` (including `reschedule_requested`) renders on appointment rows but is not surfaced on the Dashboard. |

Three of eight. The screen is a set of counters about enquiries, not a plan for the day. Two of the three counters ("Unassigned", "Waiting") describe queue administration in a studio that may have one artist.

### Scenario G — Finding an existing client

| Search by | Works? | Evidence |
|---|---|---|
| First name | Yes | `.ilike('full_name', '%…%')` |
| Surname | Yes | substring match covers it |
| Partial name | Yes | — |
| Phone | **No** | `api.ts:307` matches `full_name` only |
| Email | **No** | same |
| Instagram | **No** | same |

All three failing identifiers are stored on the client row and already selected by the query (`api.ts:303`) — they are fetched and displayed, just not searched. This is a one-line fix with outsized effect.

Once found, understanding the relationship requires the client page plus, typically, an enquiry, a project and the Inbox — three to four further navigations, because the client page carries no bookings, payments or messages.

---

## Screen-by-screen findings

| Route / component | Finding | Priority |
|---|---|---|
| `/` `DashboardPage.tsx:82-90` | Upcoming sessions show date + status + duration only; no client name; link to `/projects/:id` rather than the appointment | P1 |
| `/` `DashboardPage.tsx:55-57` | Filters to `confirmed` and future; `proposed` appointments awaiting confirmation appear nowhere | P1 |
| `/` `DashboardPage.tsx:62-71` | Three enquiry counters are the visual anchor of the screen; "Unassigned"/"Waiting" are queue-admin metrics | P2 |
| `/enquiries` `EnquiriesPage.tsx:325-338` | Rows show reference number; no client name | P1 |
| `/enquiries` `api.ts:240` | Search matches `reference_number` only; placeholder `ENQ-2026-…` confirms the intent | P1 |
| `/enquiries` `EnquiriesPage.tsx` | The manual-enquiry `<details>` form sits above the list and its own 13 fields; blocked without a selected artist, with the reason given only on submit | P2 |
| `/enquiries/:id` `EnquiryDetailPage.tsx` | Nine visually identical stacked sections; reference images are sixth | P2 |
| `/enquiries/:id` `EnquiryEditPanel.tsx:36,82` | Consultation booking is gated behind `editEnquiry`, and disappears when editing starts | P1 |
| `/enquiries/:id` `EnquiryWhatsAppPanel.tsx:146` | Renders raw `message.status` (`queued`, `sent`) untranslated, while `ConversationPage` translates the same values | P3 |
| `/clients` `ClientsPage.tsx:56-71` | Rows show name, email, first-seen date and artist chips — but no stage, no next appointment, no last contact | P2 |
| `/clients` `ClientsPage.tsx:26-32` | Loads **all** enquiries and **all** projects on every render purely to derive artist chips | P2 |
| `/clients/:id` `ClientDetailPage.tsx:55-129` | No appointments, payments, messages or follow-ups | P1 |
| `/clients/:id` `ClientDetailPage.tsx:57` | Back link is hard-coded to `/clients` regardless of entry point | P2 |
| `/projects` `ProjectsPage.tsx:22-36` | A "How to create a project" instructional card is pinned above the list permanently, including for established users with many projects | P2 |
| `/projects` `ProjectsPage.tsx:52-61` | Rows show title, status, deposit, updated date — no client name | P1 |
| `/projects/:id` `ProjectDetailPage.tsx:155-174` | Client name never appears; only an "Open client" badge | P1 |
| `/projects/:id` `ProjectDetailPage.tsx:299-300` | Booking is hidden inside a `<details>` labelled "Add another appointment" | P2 |
| `/projects/:id` `ProjectDetailPage.tsx:229-250` | Appointment rows carry 6 badges before any action buttons | P2 |
| `/appointments` `AppointmentsPage.tsx:236-345` | The create form is placed above the schedule; the schedule is what the visit is usually for | P2 |
| `/appointments` `AppointmentsPage.tsx:281-291` | Client chooser is a native `<select>` over up to 200 clients, no search | P1 (mobile) |
| `/appointments` `AppointmentsPage.tsx:~430-470` | Rows render up to nine badges at uniform weight; the client name is one of them, in the third meta row | P1 |
| `/appointments` | No day, week or agenda view; no "today" separator | P1 |
| `/payments` `PaymentsPage.tsx:513-516` | Hard block requiring an artist that cannot be selected on this route | **P0** |
| `/payments` `PaymentsPage.tsx:757-786` | Deposit-eligible appointments listed without client names | **P0** |
| `/payments` `PaymentsPage.tsx:821` | `project_id.slice(0, 8)` — a raw UUID fragment shown to the user | P2 |
| `/payments` `PaymentsPage.tsx:796` | `{language === 'ru' ? 'Multiple Sessions' : 'Multiple Sessions'}` — untranslated in both languages | P2 |
| `/payments` `PaymentsPage.tsx:934-966` | Match → Confirm two-step on an already-suggested match | P1 |
| `/payments` | Seven panels on one screen mixing daily work (reconcile, request) with one-time setup (connection, catalogue, policy) | P1 |
| `/inbox` `InboxPage.tsx:89,157-159` | Email tab returns a hard-coded empty list plus an explanation | P1 |
| `/inbox/:id` `ConversationPage.tsx` | No booking, deposit or stage context while replying | P1 |
| `/inbox/:id` `ConversationPage.tsx:~400` | "Search clients by name" — same name-only limitation when linking a sender | P1 |
| `/notifications` `NotificationsPage.tsx:47,64` | English-only error fallbacks (`'That did not work.'`) regardless of language | P2 |
| `/notifications` | Mixes a notification inbox with Telegram connection *configuration* on one screen | P2 |
| `AppShell.tsx:189-224` | Three rows of chrome above content on mobile; brand text repeated in sidebar and header | P2 |
| `styles.css:327-336` | `.badge` has no `min-height` and 2px vertical padding (~20px tall) yet is used as a tappable link throughout; two call sites patch `minHeight: 44` inline (`DetailContext.tsx:15`, `ProjectsPage.tsx:32`), proving the gap is known | P1 (mobile/a11y) |

---

## Information architecture

### Entity exposure

| Entity | Exposed to the user? | Does the user need the distinction? |
|---|---|---|
| Enquiry | Yes — its own nav item, list and detail page | Partly. To the artist it is "someone asked about a tattoo" — the first message, not a separate object. |
| Client | Yes | Yes. |
| Project | Yes — nav item, list, detail | **No.** The artist thinks "the sleeve". Project vs Client is only visible when one client wants two different pieces — rare. |
| Appointment | Yes | Yes, but as "session" or "consultation", which the type field already provides. |
| Consultation | As an appointment *type*, but with a separate booking form on a different screen | It is an appointment. Two booking UIs for one concept. |
| Conversation | Yes | Yes — but should not be a separate destination from the client. |
| Payment request | **Yes, as a first-class object in a dropdown** | **No.** This is a database row. |
| Reconciliation candidate | **Yes, as the primary Payments object** | **No.** The user's model is "money arrived". |
| Follow-up | Yes | Yes — "remind me". |
| Automation | Yes — its own nav item and a Studio page | No, not in primary navigation. |
| Integration | Yes | Only during setup. |

### Conceptual overlaps

- **Client vs Enquiry** — the CRM keeps a *submitted* contact snapshot alongside the stored client (`EnquiryDetailPage.tsx:224-234`), which is correct: an enquiry form can disagree with the client record and silently overwriting would be worse. But it surfaces as two equally weighted contact blocks. It should be one block, with a diff shown only when `submittedContactDiffers` is true (the function already exists at `EnquiryDetailPage.tsx:35-45`).
- **Project vs Booking** — the sharpest overlap. A tattoo session requires a project; a consultation does not. That is a data-integrity rule leaking into the interface as a booking precondition the user must learn.
- **Conversation vs Channel** — handled well in the Inbox (channel is a badge and a filter). Undermined by Email and Telegram living elsewhere.
- **Deposit vs Payment** — three names for one idea: `deposit_status` on the project, `payment_status` on the appointment, and `payment_request` + `reconciliation_candidate` in Payments. A project row can show "Deposit: paid" while its appointment shows "Session payment: unpaid" — both true, and confusing.
- **Task vs Automation** — Follow-ups (manual) and Lifecycle Automations (scheduled) are the same concept to the operator: "something should happen later." Two nav items, two mental models.

**Recommendation:** keep the data model exactly as it is — it is sound, and the RLS/RPC boundaries depend on it. Change only the presentation: present *the client and their work*, and let the CRM resolve which entity an action touches. Nothing below requires a migration.

---

## Visual hierarchy

- **Where the eye lands first.** On most screens, the first `.card` — which is often a form or an instructional notice rather than the content. On `/projects` it is "How to create a project"; on `/appointments` it is the create form; on `/enquiries` it is the search box.
- **Competing elements.** Badges. `.badge` (`styles.css:327-336`) is one uniform pill used for status, type, duration, payment state, calendar sync, artist attribution, client links, enquiry links, project links and back navigation. Nine on one appointment row, visually identical, so the eye cannot rank them.
- **Card monotony.** `Section` renders `.card` (`StateViews.tsx:51-61`) with `h2` at `0.95rem` weight 600 (`styles.css:304`). Ten sections on a page look like ten equal things.
- **Type scale.** Compressed: `h2` at 0.95rem, `.row .title` at 0.96rem, `.meta` at 0.82rem, `.badge` at 0.72rem. The largest text on most screens is the topbar brand (1.15rem) — the least useful element. The only strong type is `.stat .value` at 1.6rem, used for enquiry counters.
- **Borders.** Every card, row, badge, input and notice has `1px solid var(--border)`. A list of five appointments each with nine badges draws roughly 50 borders.
- **Primary actions.** A `.primary` class exists and is used sparingly — but on several screens (`/appointments` create, project Confirm/Complete/No-show/Cancel) every button is default-styled, so destructive and routine actions look identical apart from `.danger`.
- **Colour semantics.** Consistent and correct where applied: `ok` green, `warn` amber, `danger` red (`styles.css:337-339`). The failure is under-use — most badges are neutral grey, so "Deposit: paid" and "Duration: 5h" read the same until you read the words.

**Contrast — requires production URL.** `--muted` and `--faint` on the dark surface are used for `.meta`, `.badge` and `.timeline .when` at 0.72–0.82rem. This is the most likely WCAG AA failure in the product and should be measured on a rendered page rather than asserted from tokens.

---

## Cognitive load

Concrete moments where the operator must stop and think, each with a fix:

| Moment | Where | Fix |
|---|---|---|
| "Which enquiry is Anna's?" | `/enquiries` — references only | Show client names |
| "Why can't I book a session?" | `/appointments` — "project required" appears after choosing a type | Offer *Book a session* from the client and create/attach the project silently |
| "Did that save?" | Every create form — success clears the form and reloads, with no message | A confirmation line naming what was created and a link to it |
| "Is this a conflict I should care about?" | Conflicts warn on one screen and block on another | One policy, one wording |
| "What is a reconciliation candidate?" | `/payments` | Say "£150 received on 28 Aug" and name the client |
| "Which artist am I looking at?" | Scope selector shows on some routes, a "Global section" notice on others, and a hard block on `/payments` | Consistent placement; never require a control that is not present |
| "Did I already confirm this appointment?" | `proposed` vs `confirmed` badges differ only in text and a green tint | Surface unconfirmed appointments as an explicit worklist item on Today |
| "Where do I reply to this client?" | Two WhatsApp UIs | One conversation surface |
| "What does `3f8a1c2e` mean?" | `PaymentsPage.tsx:821` | Remove |

---

## Forms

| Form | Findings |
|---|---|
| **Manual enquiry** (`EnquiriesPage.tsx`) | 13 fields, of which only name, email and a privacy checkbox are required — reasonable. But it is blocked without a selected artist and only says so on submit (`EnquiriesPage.tsx:99-102`). Uses an idempotency key correctly. No draft persistence: navigating away loses everything. |
| **Client edit** (`ClientEditPanel.tsx`) | Reasonable field set. Toggle-based rather than `<details>` — inconsistent with sibling panels. |
| **Enquiry edit** (`EnquiryEditPanel.tsx:119-137`) | Five text inputs plus a textarea. `maxLength` is set on each — good. Hides the consultation panel while open. |
| **Appointment create** (`AppointmentsPage.tsx:236-345`) | Two `datetime-local` fields where one date/time plus a duration would do — duration shortcut buttons already exist (`AppointmentsPage.tsx:346-352`) and immediately overwrite the end field, which makes the end field mostly redundant. Client `<select>` over 200 options with no search. Project/enquiry/client are three separate selects that partly auto-fill each other (`AppointmentsPage.tsx:87-96`) — the auto-fill is good, the three-select presentation is not. |
| **Consultation** (`EnquiryConsultationPanel.tsx`) | Better shape — type, datetime, duration dropdown, notes. Should be the model for all booking. Still no availability offered. |
| **Deposit / policy** (`PaymentsPage.tsx`) | Asks for percentage, fixed amount, minimum and rounding on one form with no preview of the resulting amount. `DEFAULT_DEPOSIT_TIERS` exist in code (`PaymentsPage.tsx:28-33`) but are not offered as a starting point in the policy form. |
| **Payment destination** (`PaymentsPage.tsx`) | Requires pasting a Monzo URL per amount tier — inherently manual, but the "Replace" button fills only the amount and clears the URL (`PaymentsPage.tsx:~615`), which reads as a bug. |
| **Integrations / automations** | Configuration surfaces; acceptable density for their frequency. |

**Cross-cutting form problems:** no draft state anywhere; no `autoComplete` attributes on client contact fields; validation is submit-time rather than inline; and success feedback is universally absent — forms clear and lists reload silently.

---

## Feedback after actions

| Action | Current feedback | Adequate? |
|---|---|---|
| Save (client, enquiry) | Panel closes, data reloads | No — no confirmation |
| Create appointment | Form clears, list reloads | No — no confirmation, and the new row is not highlighted |
| Create enquiry | `manualSuccess` message naming the reference | **Yes** — the best example in the product |
| Delete enquiry/client | CRM dialog, then navigate to the list | Yes |
| Send message | Composer clears, thread reloads with a `queued` status | Yes |
| Match payment | `reconciliationNotice` set | Yes |
| Confirm payment | Notice including the resulting status | Yes |
| Book / propose | Nothing | No |
| Cancel / reschedule | Row re-renders | Weak — no confirmation of the new time |
| Change status | Badge changes | Weak |
| Upload reference | List refreshes | Weak |
| Connect integration | Varies by provider | Inconsistent |

Payments has the best feedback in the CRM; booking has the worst. That is inverted relative to frequency.

One subtle case worth noting: declining a consequential dialog returns `{ data: null, error: null }` (`consequential-client.ts:257`), so the caller's `run()` treats it as success and reloads. The record is correctly unchanged, but the UI gives the same silent reload for "you cancelled the appointment" and "you backed out" — the only difference being whether a badge changed.

---

## Empty, loading and error states

**Strengths.** `StateViews.tsx` is genuinely good: `LoadingState` uses `role="status" aria-live="polite"`, `ErrorState` uses `role="alert"` and offers Retry, and `EmptyState` takes a hint. Almost every screen uses them with a specific, useful hint — `enquiries.noMatchHint` explains that only completed intakes appear; `dashboard.onlyConfirmedSessions` explains why proposed sessions are missing. These answer "why is this empty?" properly.

**Weaknesses.**

- **Error text is English-only.** `friendlyMessage` (`api.ts:72-81`) returns `"You do not have permission to {what}."` or `"Could not {what}. Please try again."`, where `{what}` is an English verb phrase passed from ~25 call sites in `api.ts` and ~70 across `lib/`. In Russian the user sees a translated title above an English sentence.
- **Errors do not say whether data was affected.** "Could not load that client. Please try again." is fine for a read. The same shape is used for writes, where the user's real question is "did it save?"
- **No offline or network-loss handling.** A failed fetch produces the generic message with no indication that connectivity is the cause — likely on a phone in a studio.
- **Permission errors are correctly distinguished** (`42501` / `PGRST301` → "You do not have permission to…"), which is better than most CRMs manage.
- **Skeletons vs spinners.** Every load is a text line. On the client page, three parallel queries mean the whole screen is a single "Loading…" until all resolve (`ClientDetailPage.tsx:27-43`).
- **Raw provider codes leak in one place**: `calendarSyncLabel` appends `calendar_last_error_code` verbatim (`ProjectDetailPage.tsx:456-458`), producing badges like `failed: INVALID_GRANT`.

---

## Mobile audit

**This is the strongest area of the product**, and the mobile-first claim in `admin/README.md:3` is genuinely honoured.

### What is right

- `--tap: 44px` is defined (`styles.css:20`) and actually applied to `.row`, `input`, `select`, `button` and `.tabbar-item` (`styles.css:317,360,371,202`).
- The tab bar is fixed with `padding-bottom: env(safe-area-inset-bottom)` and a matching `min-height` (`styles.css:186-199`) — correct iPhone home-indicator handling.
- Desktop is the *enhancement*: the sidebar appears only at `min-width: 900px` (`styles.css:472`).
- `min-width: 0` is applied defensively throughout (`styles.css:31,45,47,70,84,140,201,295,303,309,319,350,410,527`) — long client names will not blow out grid rows.
- `.badge` sets `overflow-wrap: anywhere` (`styles.css:330`).
- The More sheet is a proper modal: scroll lock, focus trap, Escape, backdrop dismiss, and focus restored only when the route did not change (`AppShell.tsx:103-157`).
- `100dvh` is used alongside `100vh` (`styles.css:41-42`) — correct for mobile browser chrome.
- No data tables anywhere; everything is card rows, which is the right choice for phones.

### What is wrong

| Issue | Evidence | Impact |
|---|---|---|
| Badge-links are ~20px tall | `.badge` has no `min-height`, 2px vertical padding, 0.72rem text (`styles.css:327-336`), yet is the interactive element for "Open client", "Open enquiry", "Client: {name}" and more. Two sites patch it inline to 44px, proving the gap is known | Mis-taps on the most common cross-navigation control |
| 200-option native picker | `AppointmentsPage.tsx:281-291` over `api.listClients()` (limit 200) | An iOS wheel picker with 200 entries and no search is effectively unusable |
| Nine badges per row | `AppointmentsPage.tsx:~430-470` | On a 390px screen this wraps to 4–5 lines per appointment |
| Three rows of chrome | Brand + page title + profile, then the artist-scope row (`AppShell.tsx:189-224`) | Significant vertical loss above the fold |
| `datetime-local` for booking | `AppointmentsPage.tsx:325-334`, `ProjectDetailPage.tsx:337-357` | iOS renders a compact wheel; two of them per booking is slow and error-prone |
| Clients and Inbox behind More | `AppShell.tsx:35` | Extra tap plus a modal on the highest-frequency destinations |
| No sticky primary action | Forms end with a button below the fold | On the enquiry page the operator scrolls past nine sections to act |
| Long forms with no draft state | Manual enquiry, 13 fields | An interrupting call loses the entry |

**Requires production URL:** real iOS keyboard-avoidance behaviour, whether the fixed tab bar overlaps focused inputs, and whether `datetime-local` renders acceptably on the target device.

---

## Localization audit

The central dictionary is in good shape — **281 EN keys, 281 RU keys, zero missing on either side** (verified by extracting and diffing both objects in `i18n.tsx`). Russian pluralisation is handled correctly for failure counts (`DashboardPage.tsx:197-210`). The Russian copy that exists reads naturally and idiomatically.

All the damage is outside the dictionary.

### Untranslated strings reaching the user

| String | Cause | Evidence |
|---|---|---|
| **"Communications"** in the sidebar and More sheet | `NAV_KEYS` (`AppShell.tsx:18-30`) has no `/inbox` entry, so the code falls back to `item.label` = `'Communications'` (`permissions.ts:195`), and `translate()` returns the key unchanged when it is not in the dictionary (`i18n.tsx:617`) | Renders in English in Russian mode |
| **"Payments"** in the sidebar and More sheet | Same path via `permissions.ts:202` | Same |
| **"Multiple Sessions"** | `{language === 'ru' ? 'Multiple Sessions' : 'Multiple Sessions'}` | `PaymentsPage.tsx:796` |
| ~70 API error messages | `friendlyMessage` returns English templates composed with English verb phrases | `api.ts:72-81` |
| `'That did not work.'`, `'Could not update Telegram notifications.'` | Hard-coded fallbacks | `NotificationsPage.tsx:47,64` |
| Message statuses (`queued`, `sent`, `failed`) | Rendered raw | `EnquiryWhatsAppPanel.tsx:146` |
| Calendar provider error codes | Appended verbatim to a badge | `ProjectDetailPage.tsx:456-458` |

`/availability` and `/automations` avoid the nav bug only because `navigationLabel()` hard-codes their Russian strings separately (`AppShell.tsx:474-479`) — a workaround that masks the underlying gap rather than fixing it.

### Terminology inconsistencies

The same concept is named differently across screens. This list should be resolved into one glossary before any copy work.

| Concept | Variants in the product | Evidence |
|---|---|---|
| Appointment | `nav.sessions` = "Sessions"/"Сеансы"; nav label override = "Appointments"/"Записи"; project section = "Appointments"/"Записи"; route aliases `/appointments` and `/sessions` both exist | `i18n.tsx:55`, `AppShell.tsx:475`, `ProjectDetailPage.tsx:494,515`, `App.tsx:182-184` |
| Session payment | "Session payment" vs project-level "Deposit" vs appointment `payment_status` | `ProjectDetailPage.tsx:496`, `:489` |
| Deposit state | "not requested yet" / "not required" / "requested" / "paid" vs `depositStatus` dictionary labels | `ProjectDetailPage.tsx:469-485` vs `i18n.tsx` |
| Time off | `nav.sessions` sibling labelled "Time off"/"Выходные"; the page itself is availability management | `AppShell.tsx:476` |
| Delete vs Archive | UI says "Delete enquiry"/"Удалить заявку"; the dialog explains the record is retained; the API is `archiveEnquiry` | `EnquiryEditPanel.tsx:40,52`; `consequential-client.ts:17-18` |
| Organizations vs Workspaces | Nav label "Organizations"/"Организации"; route `/workspaces`; code says workspace throughout | `i18n.tsx:58`, `App.tsx:205` |
| Enquiry vs Lead | "Enquiry"/"Заявка" consistently — **no drift**, correctly | — |
| Artist scope | "Artist"/"Мастер", "All assigned artists", "Shared records", "Global section" — four scope vocabularies | `AppShell.tsx:498-507` |

### Structural inconsistency

Thirteen components maintain their own local `COPY` dictionaries (`ConversationPage`, `AppointmentsPage`, `ProjectDetailPage`, `InboxPage`, `CalendarConnectionsPage`, `InstagramConnectionsPage`, `OAuthConsentPage`, `PasswordSetupPage`, `ProjectDepositPanel`, `EnquiryConsultationPanel`, `ProjectEstimatePanel`, `ProjectDepositRequirementControl`, `ProjectAppointmentEditor`) plus a further set using inline `language === 'ru' ? … : …` ternaries. These are bilingual and correct, but they sit outside the dictionary that key-diff tooling can check — which is exactly why the three untranslated strings above went unnoticed.

**Russian layout:** Russian labels typically run 20–30% longer than English. The layout is defensive (`min-width: 0` everywhere, `overflow-wrap: anywhere` on badges), so overflow is unlikely — but `.tabbar-item` at `font-size: 0.67rem` across five fixed columns is the tightest spot, and "Автоматизации" (14 characters) in a 78px column **requires production URL** to confirm.

---

## Accessibility

Focusing only on issues that materially reduce usability.

**Done well:**
- `role="status"` / `role="alert"` used correctly and consistently across loading, empty and error states (`StateViews.tsx`).
- The More sheet is a correct modal dialog: `role="dialog"`, `aria-modal`, labelled, focus-trapped, Escape-dismissible, focus restored conditionally (`AppShell.tsx:103-157,263-271`).
- The consequential dialog uses `role="alertdialog"` with `aria-labelledby` and `aria-describedby`, and focuses **Cancel** first (`consequential-client.ts:~245`) — the safe default.
- `aria-current="page"` on active nav links (`AppShell.tsx:424`).
- Form controls have real labels; the reply composer uses a `visually-hidden` label rather than a placeholder (`ConversationPage.tsx:~363`).
- `document.documentElement.lang` is kept in sync with the language (`i18n.tsx:~660`).
- The artist-scope `<select>` has both a visible label and `aria-label` (`AppShell.tsx:358-362`).

**Problems that matter:**

| Issue | Evidence | Why it matters |
|---|---|---|
| Badge-links below the tap target | `.badge` has no `min-height` (`styles.css:327-336`) while serving as the primary cross-navigation control | Fails the product's own 44px standard; affects everyone on a phone, not only assistive-tech users |
| Small low-contrast text | `.meta`, `.badge`, `.timeline .when` at 0.72–0.82rem in `--muted`/`--faint` carry most of the operational information | Likely AA contrast failure — **requires production URL** to measure |
| Conflict warnings are `role="status"` | `AppointmentsPage.tsx:~356`, `ProjectDetailPage.tsx:375` | Polite live regions may not interrupt; a double-booking warning should assert |
| Status conveyed by colour plus small text only | `.badge.ok/.warn/.danger` differ by colour and border tint | The text does carry the meaning, so this is borderline — but at 0.72rem it is weak |
| Nine badges before the action buttons | `AppointmentsPage.tsx:~430-470` | A screen-reader user hears nine unlabelled fragments before reaching anything actionable |
| `<details>` used for primary workflow | `ProjectDetailPage.tsx:299` | Booking is a primary action, not progressive disclosure |
| Icon-only controls | Rare — nav icons are paired with text labels | **Not an issue**; the CRM avoids this trap |

---

## Consistency audit

| Pattern | Variants | Evidence |
|---|---|---|
| **Confirmation dialogs** | A CRM-owned `alertdialog` for 8 intercepted RPCs, **plus 10 raw `window.confirm()` sites** | `consequential-client.ts:120-131` vs `ProjectDepositPanel.tsx:128,277`, `ProjectDepositRequirementControl.tsx:43`, `ArtistOnboardingPage.tsx:636`, `PaymentsPage.tsx:332,477,495`, `WorkspaceDetailPage.tsx:572`, `AvailabilityPage.tsx:152`, `ProjectDetailPage.tsx:194` |
| **Conflict policy** | Consultation blocks; session warns and permits | `EnquiryConsultationPanel.tsx:49-52` vs `ProjectDetailPage.tsx:505` |
| **Booking UI** | Three different forms: consultation (type/datetime/duration), project (`<details>`, two datetimes), appointments page (six fields) | `EnquiryConsultationPanel.tsx`, `ProjectDetailPage.tsx:301-381`, `AppointmentsPage.tsx:236-345` |
| **WhatsApp** | Full conversation UI at `/inbox/:id`; a second reduced UI on the enquiry; plus a `wa.me` deep link out | `ConversationPage.tsx`, `EnquiryWhatsAppPanel.tsx:112-115,132-181` |
| **Hidden sections** | `<details>` (project booking, manual enquiry, submitted snapshot) vs boolean state (`EnquiryEditPanel`, `ClientEditPanel`, reschedule) | `ProjectDetailPage.tsx:299` vs `EnquiryEditPanel.tsx:26,79` |
| **Localisation** | Central `i18n` dictionary vs 13 local `COPY` objects vs inline ternaries | See Localization audit |
| **Page layout** | `.card` + `Section` on most pages; `.panel` + `.page-stack` on Payments/Users/Workspaces | `StateViews.tsx:51-61` vs `PaymentsPage.tsx:518-520`, `ControlPlane.css` |
| **Back navigation** | `DetailBackLink` on enquiry/client/project; nothing on `/inbox/:id` or `/appointments/:id` | `DetailContext.tsx` vs `ConversationPage.tsx` |
| **Duration display** | Local `durationValue`/`durationShortcut` helpers duplicated in two files | `ProjectDetailPage.tsx:438-448`, `AppointmentsPage.tsx` |
| **Opening a client** | Badge link from enquiry, badge link from project, badge link from appointment row, list row from `/clients`, link from conversation — five entry points, four visual treatments | multiple |
| **Save buttons** | `.primary` on enquiry edit and conversation send; default on appointment create, project status, deposit forms | multiple |

**Regression against the prior audit:** `docs/crm/CLICK-PATH-AUDIT-2026-08-03.md:227` recorded "Browser-native confirmations exposed the staging hostname — fixed in source." That fix covered the 8 RPC-intercepted actions only. Features added since — payments, reconciliation, deposit requirements, availability, project cancellation — reintroduced `window.confirm` at 10 sites. The fix should have been a shared component, not an RPC interceptor.

---

## Proposed navigation

### Current → proposed

```
CURRENT (13 + control plane)          PROPOSED (6)
──────────────────────────────        ─────────────────────────────
Dashboard          ─┐
Notifications      ─┴──────────────▶  Today
Communications     ─┐
Enquiries          ─┴──────────────▶  Inbox
Clients            ────────────────▶  Clients
Projects           ────────────────▶    (inside a client)
Appointments       ─┐
Time off           ─┴──────────────▶  Calendar
Payments           ────────────────▶  Payments
Automations        ─┐
Integrations        │
Users               ├──────────────▶  Settings
Activity            │
Organizations      ─┘
```

**Mobile tab bar:** Today · Inbox · Clients · Calendar · More
**Desktop sidebar:** the same six, grouped — *Work* (Today, Inbox, Clients, Calendar) · *Money* (Payments) · *Setup* (Settings).

### Justification per item

**Today** — *Why it exists:* the CRM's first job is answering "what needs me today?", which nothing currently does. *Contains:* today's and tomorrow's appointments with client names; conversations awaiting a reply; unconfirmed (`proposed`) appointments; deposits received but unconfirmed; deposits requested but unpaid; overdue follow-ups; integration failures. *Why primary:* it is the landing screen and the reason to open the app.

**Inbox** — *Why:* every piece of new work arrives as a message, whether it is a website enquiry, a WhatsApp message or an Instagram DM. Splitting Enquiries from Communications splits one queue by arrival mechanism. *Contains:* all inbound conversations and enquiries, filterable by channel and by state (needs reply / unmatched / all). *Why primary:* highest-frequency destination in the day.

**Clients** — *Why:* the CRM's central object. *Contains:* search across name, phone, email and Instagram; each client's full workspace including their projects, bookings, payments and messages. *Why primary:* second-highest frequency, and currently two taps away on mobile.

**Calendar** — *Why:* "when am I free" and "who is in today" are asked constantly and are currently unanswerable. *Contains:* day/week views of appointments, time off, and available slots; booking and rescheduling in place. *Why primary:* absorbs both `/appointments` and `/availability` and gives booking a home.

**Payments** — *Why:* money needs a dedicated place, and reconciliation is a real recurring task. *Contains:* incoming payments to confirm, deposits outstanding, and payment setup. *Why primary:* the artist checks it regularly and it has direct financial consequence. *Precondition:* fix the artist-scope deadlock first.

**Settings** — *Why:* Integrations, Automations, Users, Activity and Organizations are configured rarely and then left alone. Five primary nav slots for setup in a two-person studio is disproportionate. *Contains:* Integrations (with per-channel health), Automations, Team, Audit log, Organization. *Why primary:* one slot, not five.

---

## Proposed main workspace

Information architecture only; no visual design implied.

### Desktop — immediately after login

1. **Header strip.** Today's date; artist selector (when more than one artist is accessible — hidden entirely for a single-artist studio); profile menu. One row, not three.
2. **"Needs you now"** — the only section above the fold. A short list, empty when there is genuinely nothing, each row carrying its own action:
   - *£150 received from D DIDY — likely Diana Didy's deposit for Tue 3 Sep* → **Confirm**
   - *Anna Petrova replied 2 hours ago* → **Reply**
   - *Tue 3 Sep 11:00 with Diana Didy is still unconfirmed* → **Confirm**
   - *Mark Ellis: follow-up overdue by 2 days* → **Open**
3. **Today's schedule.** Each appointment as: client name, time, duration, type, deposit state, one-tap contact. Client name is the row title — not a badge in a third meta row.
4. **New this week.** Unhandled enquiries and DMs, by client name, with the ask in one line.
5. **Ahead.** The next 7 days, compressed to one line per day.

Order is deliberate: what is broken or waiting, then what is happening, then what is coming.

### Mobile — immediately after login

Same information, ordered for a phone held one-handed:

1. **One line of context.** "Tuesday 30 August · 2 sessions today"
2. **Needs you now** — the same actionable list, each row a single tap to its action. If empty: "Nothing needs you right now."
3. **Today** — one card per appointment: client name, time, what the piece is, deposit state, and a contact button.
4. **Then** — a compact list of the next few days.
5. **Tab bar** — Today · Inbox · Clients · Calendar · More.

Nothing above the fold should be a counter, a form, or an instruction. Every row should be something the operator can act on or needs to know.

---

## Quick wins

High impact, small effort. Each is independently shippable.

| # | Change | Files | Impact |
|---|---|---|---|
| 1 | Add `/payments` to the `artist` page scope so the selector renders | `AppShell.tsx:481-496` | Removes the P0 deadlock |
| 2 | Render an artist chooser inside the Payments empty state as well | `PaymentsPage.tsx:513-516` | Belt and braces on the same P0 |
| 3 | Extend client search to email, phone and Instagram | `api.ts:300-309` | Makes clients findable by how they contact you |
| 4 | Join client name into the enquiry list query and make it the row title | `api.ts:219-244`, `EnquiriesPage.tsx:325-338` | Removes one navigation per enquiry triaged |
| 5 | Extend enquiry search to client name | `api.ts:240` | — |
| 6 | Show client names on Payments deposit rows; delete the UUID fragment | `PaymentsPage.tsx:757-786,821` | Removes a wrong-client risk |
| 7 | Add `nav.inbox` / `nav.payments` keys and wire them into `NAV_KEYS` | `i18n.tsx`, `AppShell.tsx:18-30` | Fixes two English strings in the Russian sidebar |
| 8 | Translate the "Multiple Sessions" heading | `PaymentsPage.tsx:796` | — |
| 9 | Add `min-height: var(--tap)` and vertical padding to interactive badges | `styles.css:327-336` | Fixes the most common mis-tap on mobile |
| 10 | Change the mobile tab bar to Today / Inbox / Clients / Calendar / More | `AppShell.tsx:35` | Removes a tap and a modal from the two most frequent destinations |
| 11 | Add client name to Dashboard upcoming-session rows and link to the appointment | `DashboardPage.tsx:82-90` | Makes the first screen readable |
| 12 | Remove the dead Email tab from the Inbox | `InboxPage.tsx:118-119,157-159` | Removes a channel that cannot be used |
| 13 | Add client name to project rows and the project page header | `ProjectsPage.tsx:52-61`, `ProjectDetailPage.tsx:155-174` | You see who you are booking |
| 14 | Show the "How to create a project" card only when the list is empty | `ProjectsPage.tsx:22-49` | Reclaims the top of a daily screen |
| 15 | Move consultation booking out of `EnquiryEditPanel` into its own section on the enquiry page | `EnquiryEditPanel.tsx:36,82-84` | Also fixes the `editEnquiry` capability coupling |
| 16 | Add a success message to every create/book action | `AppointmentsPage.tsx`, `ProjectDetailPage.tsx` | Removes "did that save?" |
| 17 | Route the 10 `window.confirm` sites through the existing CRM dialog | 7 files | One confirmation experience |
| 18 | Make the conflict notice `role="alert"` and identical on all three booking forms | 3 files | One safety rule |
| 19 | Translate `friendlyMessage` via the dictionary (keys, not English phrases) | `api.ts:72-81` + call sites | Fixes the single largest localisation gap |
| 20 | Replace the client `<select>` on `/appointments` with the debounced search already used elsewhere | `AppointmentsPage.tsx:281-291` | Makes booking usable on a phone |

Items 1–3, 6, 7, 8 and 9 are each under an hour and remove the two P0 issues plus the sharpest localisation and mobile defects.

---

## Structural improvements

Larger changes, only where the evidence justifies them.

**S1 — Today screen replacing the Dashboard.** *Justified because:* the current Dashboard answers three of eight morning questions (Scenario F) and its primary visual element is a set of enquiry counters. *Scope:* new aggregate query spanning appointments, conversations, payment candidates and follow-ups; new screen; the existing Dashboard becomes a Settings-level statistics view or is removed. *Impact:* High. *Effort:* Medium.

**S2 — Client workspace.** *Justified because:* six of nine operational questions are unanswerable on the client page (Client workspace audit). *Scope:* status header, next-action block, inline conversation, merged work list, unified timeline. *Impact:* High. *Effort:* Medium–Large.

**S3 — Calendar view.** *Justified because:* there is no "today" and no way to see availability while booking (Scenarios B, C, F). *Scope:* day/week view merging appointments and time off; slot-based booking; absorbs `/availability`. *Impact:* High. *Effort:* Large.

**S4 — One booking component.** *Justified because:* three booking forms exist with two different conflict policies and three field sets. *Scope:* a single `BookingPanel` taking client + optional project + type, offering free slots, with one conflict policy; used from client, enquiry, project and calendar. *Impact:* High. *Effort:* Medium.

**S5 — Payments split into work and setup.** *Justified because:* seven panels mix daily reconciliation with one-time Monzo configuration. *Scope:* "Money" (incoming to confirm, deposits outstanding) stays primary; connection, catalogue and policy move to Settings. Reconciliation collapses to one confirm action on a suggested match. *Impact:* High. *Effort:* Medium.

**S6 — Unified Inbox including email.** *Justified because:* the Inbox covers 2 of 4 channels and the email tab is a placeholder. *Scope:* bring Gmail threads into `conversations`; remove the enquiry WhatsApp panel in favour of a link; add booking and deposit context to the conversation header. *Impact:* High. *Effort:* Large — depends on the Gmail integration's thread model.

**S7 — Consolidate navigation to six items.** *Justified because:* 13 primary destinations for a two-person studio, four of them rarely-used configuration. *Scope:* Settings hub; merge Enquiries into Inbox; merge Time off into Calendar; Projects reached from the client. *Impact:* Medium–High. *Effort:* Medium. *Depends on:* S1, S3, S6.

**S8 — Localisation consolidation.** *Justified because:* three untranslated strings reached production precisely because they live outside the checkable dictionary. *Scope:* migrate 13 local `COPY` objects into `i18n`; convert `friendlyMessage` to keys; add a test asserting EN/RU key parity and that no `t()` call falls through to its key. *Impact:* Medium. *Effort:* Medium.

---

## Recommended implementation order

Sequenced for dependencies and regression risk. The CRM has real test coverage (56 files under `src/test/`), including `navigation-shell.test.tsx` and `workflows.test.tsx` — extend these alongside each phase rather than after.

### Phase 0 — Correctness (days)
*No layout change; lowest regression risk.*
1. Payments artist-scope deadlock (Quick wins 1, 2) — **P0**
2. Client names on Payments rows; remove the UUID fragment (6) — **P0**
3. Client and enquiry search extension (3, 4, 5)
4. Nav translation keys and the untranslated heading (7, 8)
5. Badge tap targets (9)

*Exit:* every P0 closed; a client is findable by phone, email or Instagram; no English strings in the Russian navigation.

### Phase 1 — Name the client everywhere (1–2 weeks)
*Presentation only; no data model change.*
6. Client names on enquiry, project and dashboard rows (4, 11, 13)
7. Client name in the project page header (13)
8. Client `<select>` → search on `/appointments` (20)
9. Mobile tab bar recomposition (10)
10. Success feedback on create/book (16)
11. `ProjectsPage` how-to card shown only when empty (14)

*Exit:* no list in the CRM identifies a client by a reference number or a UUID. Highest ratio of daily-friction removed per unit of work.

### Phase 2 — One way to do each thing (2–3 weeks)
*Consistency; moderate regression risk, well covered by existing tests.*
12. Single confirmation component across all 18 sites (17)
13. One conflict policy across all three booking forms (18)
14. Consultation panel extracted from `EnquiryEditPanel` (15)
15. Remove the dead Email tab; replace the enquiry WhatsApp panel with a link (12)
16. `friendlyMessage` localisation plus the key-parity test (19, S8 first half)

*Exit:* one confirmation pattern, one conflict rule, one WhatsApp surface, no English error text.

### Phase 3 — Today and the client workspace (3–4 weeks)
*The first genuine IA change. Ship Today first — it is independently valuable and de-risks Phase 4.*
17. **S1 — Today screen**
18. **S2 — Client workspace** (status header and next action first; unified timeline second)

*Exit:* the morning question is answerable in under 10 seconds; the client page answers all nine operational questions.

### Phase 4 — Calendar and booking (4–6 weeks)
*Largest surface change; depends on Phase 3 for entry points.*
19. **S3 — Calendar view**, absorbing `/availability`
20. **S4 — One booking component**, used from all four entry points

*Exit:* booking is date-plus-duration from offered availability, from anywhere, in three interactions.

### Phase 5 — Payments and Inbox (3–5 weeks)
21. **S5 — Payments split**; one-click confirmation of suggested matches
22. **S6 — Unified Inbox** including Gmail *(scope pending a review of the Gmail thread model — this estimate is the least certain in the plan)*

*Exit:* deposit confirmation is one click; one place to see who is waiting for a reply.

### Phase 6 — Navigation consolidation (1–2 weeks)
23. **S7 — Six primary items plus a Settings hub**
24. **S8 — Complete localisation consolidation**

*Do this last.* Once Today, the client workspace, Calendar and the unified Inbox exist, the navigation collapse is mostly deletion. Doing it earlier would move screens that are about to be replaced.

### Sequencing risks

- **Phase 4 before Phase 3 would be wrong.** The calendar's value depends on Today and the client workspace existing as entry points.
- **Phase 6 before Phase 3 would be wrong.** Merging Enquiries into Inbox before the Inbox handles all channels would lose function.
- **S6 is the least predictable item.** Gmail's thread model may not map onto `conversations` cleanly; scope it with a spike before committing to the estimate.
- **The artist-scope model is load-bearing.** Both P0 fixes touch it. `artist-scope.test.tsx` and `navigation-shell.test.tsx` should be extended before, not after, those changes.

---

## What the CRM already gets right

Stated explicitly, because it should not be lost in a redesign:

- **Mobile-first is real**, not a claim — 44px targets, safe-area insets, `100dvh`, and a desktop sidebar that is the enhancement rather than the baseline.
- **The permission model is honest.** `permissions.ts:1-13` states plainly that nothing in it is a security control, and the UI hides only what the database would refuse anyway.
- **Empty and error states are specific.** "Only enquiries whose images finished uploading appear here" tells the user something true and useful.
- **The consequential-action dialog is well built** — correct roles, focus on the safe option, bilingual, backdrop and Escape handling.
- **"An inbound DM is not an enquiry"** (`ConversationPage.tsx:4-9`) is a genuinely good product decision, correctly reasoned and correctly implemented.
- **Status transitions are server-driven** (`permissions.ts:171-181`), so the UI never offers an action that would fail.
- **Calendar sync state is surfaced per appointment** rather than hidden — the CRM tells the truth about what it does and does not know.
- **The artist-scope concept is coherent** and correctly persisted, validated against the accessible list rather than trusted from storage.
- **Russian pluralisation is handled properly**, which is more than most bilingual products manage.
- **The code documents its own intent.** Several findings in this audit were confirmed from comments explaining *why* a decision was made — that is rare and valuable.

The recommendation is not to rebuild this CRM. It is to stop making the operator do the joins.
