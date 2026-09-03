# Privacy-safe PostHog product analytics

## Outcome

The Vishar CRM emits four explicit product events so the owner can see how the
CRM is actually used, without PostHog ever receiving customer data, operator
identity, or anything that could be joined back to a CRM record.

## Why not `posthog-js`

The PostHog browser SDK's value is autocapture, session replay, person profiles
and persistent identity. Every one of those is forbidden here, and installing
the SDK would mean the privacy boundary depends on getting a dozen opt-outs
right at every call site. Instead `admin/src/lib/product-analytics.ts` sends a
single explicit POST to the PostHog capture endpoint with a fixed schema.

The cost is that funnels built on `$pageview`, replay and person-level analysis
are unavailable. That is the intended trade.

## Functional requirements

1. Exactly four events may be sent: `crm_screen_viewed`, `crm_enquiry_converted`,
   `crm_appointment_booked`, `crm_conversation_reply_outcome`.
2. Every property is a bounded enum or a small integer bucket. There is no
   free-text property anywhere in the registry.
3. A screen view carries a normalized screen name derived from a fixed route
   table, never `location.pathname`.
4. An event whose properties fail validation is dropped whole, never sent
   partially.
5. Analytics is off unless the build carries both an approved PostHog project
   key and an approved ingestion host.

## Security and privacy requirements

- No autocapture, session replay, heatmaps, web vitals or console capture.
- No `identify`, no `$set`, no person properties. `$process_person_profile` is
  `false` on every event, so PostHog creates no person record.
- A fresh random distinct ID per event, so no two events are joinable into a
  session or an operator's behaviour over time.
- `$current_url`, `$referrer`, `$referring_domain` and `$ip` are explicitly
  nulled, so the raw URL, referrer and IP-derived geography never arrive.
- No CRM record ID, client name, email address, phone number, Instagram handle,
  message body, attachment or project title is an analytics property.
- Only `eu.i.posthog.com` and `us.i.posthog.com` are accepted. An unapproved
  host disables analytics rather than being rewritten.
- The request sends no credentials and follows no redirect.
- Transport is fail-open with a 2s abort: a blocked, offline or failing
  endpoint is invisible to the operator and cannot interrupt a workflow.

## Rollout requirements

- No database migration and no new endpoint.
- The project key and ingestion host are publishable, client-visible values
  supplied as repository variables at build time. Both are absent by default, so
  a build without them ships no analytics.
- The deploy workflows reject a malformed key or an unapproved host rather than
  deploying a misconfigured build.

## Non-goals

- Marketing attribution, UTM tracking or campaign analysis.
- Feature flags, experiments or surveys.
- Any analytics on the public marketing site.
- Server-side analytics from Workers. Sentry observability covers the Worker
  path and is deliberately a separate boundary.
