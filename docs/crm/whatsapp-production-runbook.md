# WhatsApp Business Platform production runbook

This runbook covers the first production activation of WhatsApp messaging for
Vishar CRM.

It is intentionally split into independent gates. Database migrations, Meta
onboarding, Cloudflare Worker provisioning, webhook exposure, scheduled drain
activation and private CRM deployment are separate production changes. Passing
one gate does not authorise the next.

Nothing in this document is permission to modify production. Every step marked
**manual** or every workflow run with `deploy=true` requires a separate explicit
production approval immediately before it is performed.

Never paste access tokens, app secrets, webhook verify tokens, Supabase backend
keys, OAuth codes, cookies or other secret values into chat, Git, a PR body or a
workflow input.

---

## 0. Re-verify before every phase

Do not trust the values below as a future handoff. They describe the last verified
WhatsApp release boundary and must be checked again before acting.

| Check | Last verified live boundary |
|---|---|
| Release branch | resolve the current approved `release/private-crm-rc<N>` branch fresh |
| Exact validated head | resolve the current release HEAD fresh; do not copy an older SHA |
| Production DB | through migration `0048` only |
| Pending WhatsApp DB migrations from production `0048` | `0049`, `0050`, `0051`, `0052` |
| Production WhatsApp integrations | `0` |
| Production WhatsApp outbox jobs | `0` |
| Retained staging DB | migration `0044`, untouched |
| Scheduled drain Worker | not activated by repository validation |
| Public webhook Custom Domain | must be independently verified before deploy |
| Real Meta messages | none sent by repository validation |

Required repository evidence before any production step:

1. The selected release branch still has the exact approved head.
2. Static Validation is green on that exact head.
3. CRM and booking validation is green on that exact head.
4. The Public site and Worker job is green, including WhatsApp production
   configuration checks and committed-secret scan.
5. The Private CRM job is green.
6. Clean Supabase reset, full pgTAP and PostgreSQL error-level lint are green.
7. No newer product PR has superseded the selected release branch.
8. Retained staging has not been rebased, reset or repurposed for production.

Stop if any item differs. Build a new release candidate rather than mixing
partially validated heads.

---

## 1. Meta production account and phone state - manual

Complete this in the Meta business interface using the real business accounts.
Do not change a phone registration merely because the repository is ready.

For **each artist separately**, establish and record outside the repository:

- the WhatsApp Business Account id used for that artist;
- the phone-number id used for that artist;
- a production access token with the minimum permissions required by the
  approved Meta setup;
- the app secret used to validate signed webhook POST requests.

The encrypted Worker envelope shape expected by the code is:

```json
{
  "phoneNumberId": "...",
  "accessToken": "...",
  "wabaId": "...",
  "appSecret": "..."
}
```

The values above are examples of field names only. Do not put real values in a
file, issue, PR, workflow input or chat.

Vladimir and Kristina must remain separate bindings. Do not create a global
WhatsApp token, global phone-number binding or fallback from one artist to the
other.

Before changing the registration state of an existing WhatsApp Business App
number, verify the current Meta coexistence/migration contract in Meta's current
official documentation and the actual account UI. The CRM does not rely on an
undocumented Business App message-echo event. If coexistence cannot be proven
for the actual account state, stop rather than migrating a live number by
assumption.

The current CRM transport implements plain text sends only. It has no approved
message-template send path. Verify the current Meta messaging-window and
billing rules immediately before real production sending; do not infer them
from old documentation or from this runbook.

---

## 2. Database validation-only gate

Run this before any database write:

```text
Workflow: Deploy private production CRM database
Branch:   release/private-crm-rc<N>
Inputs:   approved_sha = <exact current release HEAD>
          deploy = false
          approval_phrase = (empty)
```

Expected validation-only behavior:

- exact release branch/SHA check;
- clean local Supabase reset without seed;
- full pgTAP;
- PostgreSQL error-level lint;
- production migration list;
- production `db push --dry-run` only;
- no production schema write.

While production remains at `0048`, the dry-run must propose exactly `0049`,
`0050`, `0051` and `0052` in repository order. If another migration appears, if the
production migration history has changed, or if the target is not the exact
production project, stop and rebuild the release plan.

---

## 3. Apply production migrations - separate approval

Only after step 2 is green and a fresh production backup/restore point is
confirmed.

Temporarily set the protected `crm-production` environment variable:

```text
CRM_PRODUCTION_DB_DEPLOY_ENABLED=true
```

Then run the same database workflow from the exact approved release SHA with:

```text
deploy = true
approval_phrase = DEPLOY_PRIVATE_CRM_DATABASE
```

Immediately return the enable variable to `false` after the run.

Postconditions before proceeding:

- migration history contains `0049`, `0050`, `0051`, `0052` exactly once and in order;
- production WhatsApp integration rows are still absent until deliberately
  provisioned;
- WhatsApp outbox is still empty;
- unrelated Telegram, Calendar, Storage and booking state is unchanged;
- retained staging remains untouched.

There is no down-migration procedure. If a production migration succeeds and a
later problem is found, fix forward unless the pre-migration restore point can
be used before any new production data is written.

---

## 4. Provision the two artist integrations - manual

Provision WhatsApp routing only after the database schema is live.

Each enabled integration must be artist-scoped and use the provider expected by
the code. The non-secret database routing metadata must never contain an access
token, app secret, webhook verify token or Supabase credential.

Required invariant:

```text
Vladimir CRM route -> Vladimir encrypted Worker binding -> Vladimir Meta phone
Kristina CRM route -> Kristina encrypted Worker binding -> Kristina Meta phone
```

Forbidden:

```text
Vladimir -> global WhatsApp binding
Kristina -> global WhatsApp binding
missing artist route -> other artist's binding
browser/GPT input -> arbitrary artist id or arbitrary destination
```

After provisioning, verify artist IDs, integration keys, provider type and
`is_enabled` state without displaying any secret values.

---

## 5. Cloudflare Worker bootstrap - manual

Two production Workers are distinct:

```text
vishar-whatsapp-drain-production     scheduled outbound delivery
vishar-whatsapp-webhook-production   public inbound/status callback
```

### 5.1 Scheduled drain Worker

It has no public route. Its tracked config keeps:

```text
workers_dev = false
preview_urls = false
WHATSAPP_DRAIN_ENABLED = false
```

Before the guarded activation workflow can enable its cron, provision exactly
these encrypted Worker secret names:

```text
SUPABASE_SECRET_KEY
ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION
ARTIST_WHATSAPP_KRISTINA_HPRODUCTION
```

The workflow checks the name set exactly. Extra global or legacy WhatsApp
secret names are a deployment failure.

### 5.2 Public webhook Worker

Pre-provision the Worker and its exact Custom Domain:

```text
Worker:   vishar-whatsapp-webhook-production
Hostname: whatsapp.vishartattoo.com
Path:     /webhook
```

Keep Workers.dev and preview URLs disabled. The Custom Domain is the only
approved public hostname for this Worker.

Do **not** place Cloudflare Access in front of the Meta webhook callback. Meta
must be able to reach it without a browser session. Authentication is instead
enforced by the webhook verification token for the verification handshake and
by raw-body `X-Hub-Signature-256` validation plus exact WABA/phone routing for
POST delivery.

Provision exactly these encrypted Worker secret names:

```text
SUPABASE_SECRET_KEY
WHATSAPP_WEBHOOK_VERIFY_TOKEN
ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION
ARTIST_WHATSAPP_KRISTINA_HPRODUCTION
```

The guarded workflow reads secret **names only**. It never reads or prints
secret values and contains no `wrangler secret put` command.

---

## 6. Webhook validation-only gate

Before exposing or updating the real callback code, run:

```text
Workflow: Deploy private production WhatsApp webhook
Branch:   release/private-crm-rc<N>
Inputs:   approved_sha = <exact current release HEAD>
          deploy = false
          approval_phrase = (empty)
```

This re-runs the webhook security tests, production config assertions, Worker
bundle dry-run and committed-secret scan. It does not deploy the Worker.

For `deploy=true`, the workflow additionally requires:

```text
CRM_PRODUCTION_WHATSAPP_WEBHOOK_DEPLOY_ENABLED=true
approval_phrase = EXPOSE_PRIVATE_CRM_WHATSAPP_WEBHOOK
```

That is a separate production approval. Return the enable variable to `false`
after deployment.

The deploy uses `wrangler --strict`; a route mismatch or unexpected secret-name
set must fail rather than silently widening the public surface.

---

## 7. Meta webhook subscription - manual

Only after the production webhook Worker is deployed and the exact callback can
be reached at:

```text
https://whatsapp.vishartattoo.com/webhook
```

In Meta:

1. Configure that exact callback URL.
2. Enter the same production verify token that is stored only as the Worker
   secret `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
3. Complete the verification handshake.
4. Subscribe only the webhook fields required by the current implementation.
5. Confirm that a callback for one artist's WABA/phone cannot resolve to the
   other artist's integration.

Do not enable additional event families simply because Meta offers them in the
UI. The Worker deliberately ignores unsupported/undocumented events.

At this point inbound delivery can write production conversation/message state,
so this step is live production activation even if outbound sending remains
disabled.

---

## 8. Outbound drain activation - separate approval

Run validation-only first:

```text
Workflow: Deploy private production WhatsApp drain
Branch:   release/private-crm-rc<N>
Inputs:   approved_sha = <exact current release HEAD>
          deploy = false
          approval_phrase = (empty)
```

For real activation, temporarily set:

```text
CRM_PRODUCTION_WHATSAPP_DEPLOY_ENABLED=true
```

and run with:

```text
deploy = true
approval_phrase = ENABLE_PRIVATE_CRM_WHATSAPP_DRAIN
```

The generated deploy config changes only the approved WhatsApp drain activation
surface: `WHATSAPP_DRAIN_ENABLED=true` and the exact five-minute cron. The
tracked template remains inert.

Return the enable variable to `false` immediately after the run.

Do not queue a real client message as a deployment test. First verify Worker
version evidence, cron configuration, database route metadata and empty outbox
state. A real message is a separate business action.

---

## 9. Private CRM deployment - separate approval

Only after the database and intended provider state are known-good should the
WhatsApp panel be exposed to production CRM users.

Validation-only:

```text
Workflow: Deploy private production CRM
Branch:   release/private-crm-rc<N>
Inputs:   approved_sha = <exact current release HEAD>
          deploy = false
          approval_phrase = (empty)
```

Real deployment additionally requires:

```text
CRM_PRODUCTION_DEPLOY_ENABLED=true
deploy = true
approval_phrase = DEPLOY_PRIVATE_CRM_ONLY
```

Return the enable variable to `false` immediately afterwards.

The browser does not receive Meta credentials. It can identify an enquiry or an
existing conversation, but artist, integration and WhatsApp destination are
resolved from durable server-side CRM state.

---

## 10. Post-activation verification

Use one explicitly approved real internal/test contact before any client-facing
rollout. Do not use retained-staging identities against production providers.

Verify in order:

1. Production DB migration history is exact.
2. Only the intended two artist integrations are enabled.
3. No credential value is present in CRM-readable integration metadata.
4. `whatsapp.vishartattoo.com` exposes only the intended webhook Worker and
   Workers.dev/preview bypass URLs are unavailable.
5. Meta verification succeeds without Cloudflare Access.
6. A signed inbound test event maps to the correct artist and creates no
   cross-artist conversation.
7. An invalid signature is rejected and creates no message/conversation row.
8. Unknown WABA/phone routing fails closed.
9. Delivery-status updates affect only the matching provider message id.
10. The CRM shows the conversation only to users who can access that artist.
11. Read-only staff have no send/connect controls.
12. The first approved outbound test is sent from the intended artist account
    to the explicitly approved destination only.
13. Outbox acknowledgement records the provider message id without persisting a
    provider response body containing contact data.
14. No Telegram, Calendar, public booking, Storage or retained-staging state
    changed as a side effect.

Capture run IDs, exact Worker version IDs, exact release SHA and sanitised
PASS/FAIL evidence. Do not record tokens, phone numbers or message bodies in
release evidence unless specifically required and safely redacted.

---

## 11. Rollback and containment

Use the least destructive action that stops the problem.

| Trigger | Containment |
|---|---|
| Validation-only workflow fails | Stop. Nothing to roll back |
| Webhook public surface is wrong | Remove/disable the exact webhook Custom Domain before debugging; keep retained staging untouched |
| Webhook code is wrong | Roll back the production webhook Worker to the recorded previous version |
| Wrong artist routing or credential binding | Disable the affected artist's WhatsApp integration and stop outbound activation |
| Outbound drain misbehaves | Remove/disable its cron or redeploy the inert tracked config with `WHATSAPP_DRAIN_ENABLED=false` |
| Meta subscription is wrong | Disable/remove the production webhook subscription in Meta |
| CRM UI is problematic | Redeploy the previous private CRM Pages release; do not down-migrate the DB merely to hide the panel |
| Database issue after writes exist | Stop writes and fix forward; do not run an ad hoc down migration |

Never delete or reset retained staging as part of production rollback.

---

## 12. Explicitly outside this rollout

This runbook does not authorise or implement:

- automatic template messages outside the currently supported plain-text path;
- marketing broadcasts;
- importing historical WhatsApp chats;
- undocumented WhatsApp Business App message echoes;
- GPT/ChatGPT sending client messages;
- a global WhatsApp account shared by artists;
- automatic number migration or registration;
- Meta billing changes;
- production PR merge or Ready status.

A future GPT action must call a narrow CRM messaging operation and must never
receive a Meta access token or choose an arbitrary artist/destination. That is a
separate production security review.
