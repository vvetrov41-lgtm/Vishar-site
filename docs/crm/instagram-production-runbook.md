# Instagram connector production runbook

Status: implementation complete and validated at the pull request head. Nothing
in this document has been executed against Meta or Cloudflare production.

This runbook covers the artist-scoped Instagram Professional messaging
integration described in ADR 0007. It assumes the reader has the owner role in
the CRM, admin rights on the Meta app, and access to the `crm-production`
GitHub environment.

Read `docs/crm/adr/0007-communications-domain-and-provider-adapters.md` first.
It explains why Instagram runs in its own Worker and why the artist is resolved
from the database rather than from the webhook body.

---

## 1. What exists after this change

| Surface | State in the repository |
| --- | --- |
| `workers/instagram-production.js` | Complete: webhook, OAuth, status, disconnect, scheduled drain and enrichment |
| `wrangler.instagram.production.toml` | Inert: no cron, no KV binding, every capability `"false"` |
| Migrations `0068`–`0072` | Communications core, WhatsApp migration, Instagram binding, inbox |
| CRM `Communications` and `Instagram` screens | Complete |
| Cloudflare Worker `vishar-instagram-production` | **Pre-provisioned in section 3, never by the release** |
| Custom Domain `instagram.vishartattoo.com` | **Pre-provisioned in section 3, never by the release** |
| KV namespaces | **Pre-provisioned in section 3, never by the release** |
| Meta app Instagram product | **Not configured yet** |

Nothing is live. The connector cannot reach Meta and Meta cannot reach the
connector until the steps below are performed.

---

## 2. Manual Meta actions

These require a human. Claude cannot perform them: they need a Meta login, and
Meta exposes no API for app product configuration or App Review.

### 2.1 Add the Instagram product to the Meta app

1. Open **https://developers.facebook.com/apps/**
2. Select the app already used for WhatsApp Business Platform.
3. In the left sidebar choose **Add product**.
4. On the **Instagram** card choose **Set up**.
5. Choose **Instagram API setup with Instagram login**.

What happens next: the app gains an **Instagram app ID** and **Instagram app
secret**, shown on the same page. These are *not* the Facebook app id and
secret; the Instagram Login flow requires the Instagram ones.

### 2.2 Record the Instagram app credentials

From **Instagram → API setup with Instagram login → 3. Set up Instagram business login → Business login settings**,
copy these two values. Keep the secret out of chat, tickets and commit
messages.

Instagram app ID → GitHub environment variable name:

```
CRM_PRODUCTION_INSTAGRAM_APP_ID
```

Instagram app secret → Cloudflare Worker secret name:

```
INSTAGRAM_APP_SECRET
```

### 2.3 Set the OAuth redirect URI

In **Business login settings**, in the **OAuth redirect URIs** field, add
exactly:

```
https://instagram.vishartattoo.com/oauth/instagram/callback
```

Then choose **Save**.

What happens next: Meta will only redirect to this exact URI. Any mismatch,
including a trailing slash, fails the connection.

### 2.4 Configure the webhook

In **Instagram → API setup with Instagram login → 2. Configure webhooks**,
choose **Edit** and enter:

Callback URL:

```
https://instagram.vishartattoo.com/webhook
```

Verify token — generate a random value and use the same string in both places.
Generate it with:

```
openssl rand -base64 32
```

Store that value as the Cloudflare Worker secret named:

```
INSTAGRAM_WEBHOOK_VERIFY_TOKEN
```

Then choose **Verify and save**.

What happens next: Meta issues a `GET` to the callback URL with
`hub.mode=subscribe`. The Worker compares the supplied token in constant time
and echoes `hub.challenge` only on an exact match.

**This step must be performed after rollout step 3** (the Worker must already
be deployed, with the verify token secret stored on it beforehand by section 3),
otherwise the verification request has nothing to answer it.

### 2.5 Subscribe to the messaging fields

In the same **Webhooks** panel, subscribe to exactly these three fields:

```
messages
```

```
message_reactions
```

```
messaging_seen
```

Do not subscribe to fields the connector does not interpret. Unknown events are
ignored safely, but every extra subscription is extra untrusted traffic on a
public endpoint.

### 2.6 App Review and Business Verification

`instagram_business_manage_messages` needs **Advanced Access** for any
Instagram professional account that does not have a role on the Meta app, and
Advanced Access requires **Business Verification**.

Until Advanced Access is granted, only accounts that hold a role on the Meta
app can connect. That is enough to test the whole flow end to end with the
artists' own accounts if each account is added under
**App roles → Roles → Add people → Instagram Tester**, and the invitation is
accepted at
**https://www.instagram.com/accounts/manage_access/** → **Tester invites**.

Submit for review from **App Review → Permissions and features**, requesting:

```
instagram_business_basic
```

```
instagram_business_manage_messages
```

### 2.7 Each artist connects their own account

Once rollout step 5 has enabled onboarding, each artist signs in themselves. Nobody
connects on behalf of another artist, and there is no shared connection.

1. Open **https://crm.vishartattoo.com/#/integrations/instagram**
2. Choose **Connect Instagram** on the artist's own row.
3. Sign in with **that artist's** Instagram professional account.
4. Allow the requested permissions.

What happens next: the connector verifies the returned account server-side,
stores the long-lived token encrypted in KV, and writes only the non-secret
account identity to the database. The CRM row shows **Connected**.

Claude does not do this and cannot: it requires the artist's Instagram
password and, where enabled, their second factor.

---

## 3. Cloudflare provisioning

These are one-off, performed once **before** the first deploy. They are
deliberately outside the release workflow, so a release can never create
infrastructure.

`deploy-private-production-instagram.yml` creates none of the resources in this
section. It contains no `kv namespace create`, no `secret put` and no Custom
Domain call. It generates the active Wrangler configuration from resources that
already exist and runs `wrangler deploy --strict` onto them, then verifies the
secret-name set is exactly the four names below. If the Worker, the Custom
Domain, either KV namespace or any of the four secrets is missing, the release
fails rather than provisioning it.

Order matters, because a Custom Domain and a secret both attach to an existing
Worker service:

1. create the two KV namespaces;
2. create the Worker `vishar-instagram-production`;
3. attach the Custom Domain `instagram.vishartattoo.com` to it;
4. store the four Worker secrets.

Create the two KV namespaces:

```
wrangler kv namespace create INSTAGRAM_OAUTH_STATE
```

```
wrangler kv namespace create INSTAGRAM_OAUTH_TOKENS
```

Record the two returned ids as GitHub environment variables in
`crm-production`:

```
CRM_PRODUCTION_INSTAGRAM_OAUTH_STATE_ID
```

```
CRM_PRODUCTION_INSTAGRAM_OAUTH_TOKENS_ID
```

They must be different namespaces. The release generator refuses to proceed if
they are the same, because short-lived CSRF state and long-lived encrypted
tokens must not share a keyspace.

Generate the token encryption key (32 random bytes, base64url) and store it as
the Worker secret `INSTAGRAM_TOKEN_ENCRYPTION_KEY`:

```
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

The Worker `vishar-instagram-production` and its Custom Domain
`instagram.vishartattoo.com` must both be pre-provisioned once, exactly as
`whatsapp.vishartattoo.com` was. A Custom Domain attaches to a Worker service,
so the Worker has to exist first; it is created empty and the release replaces
its code. The release runs `wrangler deploy --strict`, which compares routes
against what is already there.

Required Worker secrets, exactly four, no more:

```
INSTAGRAM_APP_SECRET
INSTAGRAM_TOKEN_ENCRYPTION_KEY
INSTAGRAM_WEBHOOK_VERIFY_TOKEN
SUPABASE_SECRET_KEY
```

The release workflow verifies this set exactly and fails on any extra or
missing name. It never reads a secret value and contains no
`wrangler secret put`.

---

## 4. Rollout order

The order matters. Each step is safe to stop at.

1. **Database.** Deploy migrations `0068`–`0072` through
   `deploy-private-production-database.yml`. Production WhatsApp keeps working
   throughout: the RPCs the deployed Workers call keep their exact signatures,
   and the WhatsApp relations remain readable under their existing names.

2. **CRM.** Deploy the private CRM Pages project. The Communications inbox
   immediately shows existing WhatsApp conversations. The Instagram screen shows
   "not configured" until `VITE_INSTAGRAM_CONNECTOR_ORIGIN` is set in the build
   environment to `https://instagram.vishartattoo.com`.

3. **Connector, inert.** Section 3 must already be complete: the Worker, the
   Custom Domain, both KV namespaces and all four secrets exist before this
   step. Run `deploy-private-production-instagram.yml` with
   `enable_oauth=false`, `enable_drain=false`, `enable_enrichment=false`. The
   release deploys the connector code and binds it to those existing resources
   with every capability off; it creates none of them. The webhook verification
   challenge answers from here on, so Meta step 2.4 can now be completed.

4. **Meta webhook.** Perform steps 2.4 and 2.5.

5. **Onboarding.** Re-run the workflow with `enable_oauth=true`. Perform step
   2.7 for each artist. Inbound Instagram messages now appear in the CRM inbox;
   replies queue but are not delivered yet.

6. **Outbound.** Re-run the workflow with `enable_oauth=true` and
   `enable_drain=true`. This adds the five-minute cron. Queued replies are
   delivered from that artist's own account.

7. **Enrichment.** Optionally re-run with `enable_enrichment=true` so
   participant handles are resolved and the inbox shows names rather than
   "Unknown sender".

Verify each step with the Cloudflare MCP live-state read described in
`.agents/skills/vishar-code-navigation/SKILL.md` section 4A: confirm the
intended Worker, version, route, bindings and cron changed, and that no
unrelated Cloudflare resource did.

---

## 5. Rollback

| Symptom | Action |
| --- | --- |
| Outbound sending misbehaving | Re-run the workflow with `enable_drain=false`. Queued messages stay queued; nothing is lost. |
| Onboarding misbehaving | Re-run with `enable_oauth=false`. Existing connections keep receiving. |
| One artist's account compromised or wrong | **Disconnect** on that artist's row in the CRM. This disables the route in the database first, then destroys the token in KV. The other artist is untouched. |
| Connector must stop entirely | Re-run with all three flags `false`. The webhook still answers 200 to Meta so notifications are not retried indefinitely, but nothing is ingested because no route resolves. |
| Database rollback needed | The communications migrations are forward-only. There is no down migration. Recovery is a restore of the production database, which is why step 1 is deployed on its own and verified before step 3. |

Disconnecting an artist does not delete their conversation history. That is
deliberate: the CRM record of what was said to a client outlives the provider
connection.

---

## 6. What the connector will not do

* It will not send outside Meta's 24 hour messaging window. The window error is
  reported to the operator as `instagram_outside_messaging_window`; the human
  agent tag is not used.
* It will not create an enquiry from an inbound message.
* It will not link a client on name or handle similarity.
* It will not store a provider media URL, because those expire.
* It will not accept an artist id, provider account or recipient from a browser.
* It will not resolve an unknown Instagram account to a default artist.

---

## 7. Operating limits

Meta documents the Instagram Conversations API at two calls per second per
Instagram professional account. The connector's scheduled drain claims at most
ten jobs per tick with a five-minute cron, so steady-state outbound stays well
inside that. A backlog drains over successive ticks rather than bursting.

The webhook processes at most one hundred events per delivery and resolves each
account's route once per request.

---

## 8. Verification checklist

Before declaring the rollout complete:

- [ ] `GET https://instagram.vishartattoo.com/webhook?hub.mode=subscribe&...` with a wrong token returns `403`
- [ ] An unsigned `POST` to `/webhook` returns `401`
- [ ] Each artist's row shows **Connected** with a token expiry roughly 60 days out
- [ ] A test DM to Vladimir's account appears only in Vladimir's inbox
- [ ] A test DM to Kristina's account appears only in Kristina's inbox
- [ ] A reply from the CRM arrives in Instagram from the correct account
- [ ] `activity_log` shows `instagram.queued` with no participant id and no message body
- [ ] Cloudflare MCP shows exactly one new Worker, one cron and two KV bindings
- [ ] The WhatsApp Worker version and cron are unchanged
