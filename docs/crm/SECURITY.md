# Vishar Tattoo CRM — security model

Last updated: 29 July 2026

Scope: the CRM and durable booking data path only. Website transport headers,
CSP and third-party script policy are covered in `TECHNICAL_AUDIT.md` and are
not repeated here.

Nothing in this document has been applied to live infrastructure.

## 1. Trust boundaries

| Zone | Trust | Holds |
|---|---|---|
| Public browser (`/booking/`) | Untrusted | Nothing secret |
| Cloudflare Worker | Trusted backend | `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, log salt |
| Supabase Postgres | Authority | All durable state; enforces RLS |
| Supabase Storage | Authority for bytes | Private bucket only |
| CRM browser (`admin/`) | Semi-trusted, authenticated | Supabase URL + anon key + user session |
| Telegram / Gmail / Calendar | External, non-authoritative | Notifications and projections |

The single most important rule: **the browser is never given authority, only
identity.** The Supabase anon key is a public identifier. It confers no
permission on its own; everything it can do is decided by RLS.

## 2. Credentials that must never reach a browser

The following must never appear in any HTML page, any client bundle, any
`admin/` build output, any log line, any API response, or any committed file:

- `SUPABASE_SERVICE_ROLE_KEY`;
- Supabase database connection strings or database passwords;
- Storage service credentials or S3-style access keys;
- `TELEGRAM_BOT_TOKEN`;
- Gmail or Google Calendar OAuth client secrets or refresh tokens;
- AI gateway signing keys;
- Cloudflare or GitHub API tokens;
- any private key.

Additionally, the browser is never given **arbitrary SQL access**. There is no
generic query endpoint, no `rpc('exec_sql')`, and no table endpoint that
bypasses RLS.

### Where secrets live instead

| Secret | Location | Set by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret | Owner, manually |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Cloudflare Worker secret | Owner, manually |
| `LOG_HASH_SALT` | Cloudflare Worker secret | Owner, manually |
| `SUPABASE_URL` | Worker variable (not secret, but environment-specific) | Owner, manually |
| Supabase anon/publishable key | CRM build-time variable | Owner, manually |
| Gmail / Calendar OAuth (later) | Encrypted server-side secret store, never an application table readable by any CRM role | Owner, manually |

No secret value is committed. `supabase/config.toml` contains local development
settings only, with no project ID, email address, password, key or token.

## 3. Authentication

### Public intake

The public intake route is unauthenticated by design, and is therefore
defended by request-shape controls rather than identity:

- **Exact origin validation.** A request whose `Origin` header is absent or
  outside the exact allow-list is rejected before any parsing or provider call.
  CORS response headers are a browser read-control, not enforcement; rejection
  is the enforcement.
- **Body-size rejection** before multipart parsing, using `Content-Length` and
  a hard streamed cap.
- **Field limits** applied server-side on every string, independent of what the
  browser claims.
- **File controls:** 1–3 files; each ≤ 4 MB decoded bytes; declared MIME in
  `{image/jpeg, image/png, image/webp}`; extension in `{jpg, jpeg, png, webp}`;
  magic bytes must match the declared type.
- **Server-side filenames.** The stored object name is derived from a
  server-generated UUID. The client never influences the storage path.
- **Honeypot** and elapsed-time signals retained as low-cost spam filters, but
  treated as signals only — both are client-controlled.
- **Idempotency key** as a client-supplied UUID, enforced by a database unique
  constraint. A replay returns the original record rather than creating a
  second one.

Rate limiting is a Cloudflare-side control (WAF or rate-limit rule) and is an
owner configuration action; it is documented in `OWNER_SETUP.md` and has not
been configured.

### CRM staff

Supabase Auth issues the session. Authorisation is entirely database-side:

```sql
-- every policy is gated on this shape
auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
  )
```

Consequences:

- A user with a valid, unexpired JWT but `is_active = false` can read and write
  nothing. Deactivation is effective immediately at the database, without
  waiting for token expiry.
- A user with no `profiles` row — for example an account created directly in
  Supabase Auth without being provisioned — has no CRM access at all.
- Role is read from `profiles.role`, never from a JWT claim the client could
  influence.

## 4. Roles and what they can do

Three roles: `owner`, `booking_manager`, `read_only`.

| Capability | owner | booking_manager | read_only |
|---|---|---|---|
| Read clients / enquiries / projects / sessions | ✅ | ✅ | ✅ |
| Update client contact data | ✅ | ✅ | ❌ |
| Enquiry status transitions | ✅ | ✅ (allowed transitions only) | ❌ |
| Assign enquiries | ✅ | ✅ | ❌ |
| Convert enquiry → project | ✅ | ✅ | ❌ |
| Manage operational project/session data | ✅ | ✅ | ❌ |
| Internal notes, follow-ups | ✅ | ✅ | read only |
| Create email drafts | ✅ | ✅ | ❌ |
| Approve / send email | ✅ | ❌ | ❌ |
| Finance columns (rates, totals, deposits, prices) | ✅ | ❌ | ❌ |
| Bulk export | ✅ (audited) | ❌ | ❌ |
| Role management, activation/deactivation | ✅ | ❌ | ❌ |
| System settings / retention | ✅ | ❌ | ❌ |
| Read `activity_log` | ✅ | limited | ❌ by default |
| Mutate or delete `activity_log` | ❌ | ❌ | ❌ |
| Hard-delete business data | ❌ (archive instead) | ❌ | ❌ |
| Direct table access from the public browser | ❌ | ❌ | ❌ |

`activity_log` is append-only for **everyone**, including the owner. There is
no `UPDATE` or `DELETE` policy on it, and the table is `FORCE ROW LEVEL
SECURITY`, so even the table owner role is subject to policy.

### Column-level isolation

Row-level security cannot hide individual columns from a role that may select
the row. Finance data is therefore protected two ways:

1. direct `SELECT` grants on finance columns of `projects` and `sessions` are
   withheld from `booking_manager` and `read_only`;
2. those roles read through `security_invoker` views
   (`projects_operational`, `sessions_operational`) that project only the
   non-finance columns.

Any future sensitive column must follow the same pattern. **Hiding a button in
the CRM is never a security control.** The `admin/` application hides controls
the current role cannot use purely to reduce confusion; the database refuses
the operation regardless.

## 5. Private file access

There is exactly one bucket, `crm-files`, and it is private. It is never marked
public, and no public URL is ever stored in the database.

Canonical, server-generated paths:

```text
clients/{client_id}/enquiries/{enquiry_id}/references/{file_id}.{ext}
clients/{client_id}/projects/{project_id}/designs/{file_id}.{ext}
clients/{client_id}/projects/{project_id}/sessions/{file_id}.{ext}
clients/{client_id}/projects/{project_id}/healed/{file_id}.{ext}
```

Every path segment except the extension is a UUID produced by the server. A
Storage policy re-derives ownership from the path and checks it against a
database row the caller is permitted to read, so a forged path fails even if it
is syntactically canonical.

Storage rules:

- no public read;
- no unrestricted bucket listing (listing is scoped to a permitted prefix);
- reads happen through short-lived signed URLs, minted per request;
- signed URLs are never logged and never persisted;
- deletion is limited to the owner role and to backend-controlled compensating
  cleanup and reconciliation.

## 6. Security-definer function rules

Every `SECURITY DEFINER` function in the schema must:

- set a fixed `search_path` (`pg_catalog, public` — or an explicitly listed
  private schema), so a caller cannot shadow a referenced object;
- have `EXECUTE` revoked from `PUBLIC`, then granted only to the roles that
  need it;
- validate both the caller's role and the input arguments;
- expose one narrow operation, never a general-purpose escape hatch;
- write an `activity_log` row in the same transaction for any state change.

There is no function that accepts SQL text, a table name, a column list, or a
dynamic filter from the caller.

## 7. Logging and PII

Structured Worker logs contain: event name, correlation ID, enquiry UUID and
reference number, stage, duration, HTTP/provider status class, and a safe error
code.

Logs must never contain:

- names, email addresses, phone numbers or Instagram handles;
- tattoo idea text or any free-text client message;
- original filenames or file content;
- signed URLs;
- tokens, keys or authorisation headers;
- raw provider response bodies, which may echo submitted PII.

IP addresses are used only as a salted hash for abuse control and are never
stored long-term in plaintext.

`workers/lib/logging.js` implements a redaction allow-list: the logger accepts
only known-safe field names and drops everything else, so adding a new field to
a request cannot silently start logging PII.

## 8. Threats explicitly addressed

| Threat | Control |
|---|---|
| Duplicate enquiry from a retry or refresh | UUID idempotency key + unique constraint + replay-returns-existing RPC |
| Enquiry lost because Telegram was down | Postgres commit is the success point; Telegram is an outbox job |
| Enquiry recorded with missing images | `intake_state` gate; incomplete intakes are kept out of the new-enquiry queue |
| Orphan objects after a partial upload | Compensating deletion + reconciliation module |
| Malicious file disguised as an image | Declared MIME + extension + magic-byte agreement |
| Path traversal / cross-client file access | Server-generated UUID paths + Storage policy ownership re-derivation |
| Script or bot calling the endpoint directly | Exact origin rejection, body-size cap, honeypot, Cloudflare rate limiting (owner action) |
| Ex-staff member with a live JWT | `is_active = false` denies at the database |
| Manager reading rates and totals | Column grants withheld + operational views |
| Someone editing history to hide an action | `activity_log` append-only, no UPDATE/DELETE policy, FORCE RLS |
| AI assistant exfiltrating the client list | Named tools only, row limits, field projection, role checks, audited writes, no SQL |
| Service-role key leaking into the CRM bundle | Key exists only as a Worker secret; a repository secret scan runs in validation |

## 9. Threats explicitly *not* addressed here

- Cloudflare WAF and rate-limit rules — owner configuration, not repository code.
- Malware scanning of uploaded images — noted in the architecture as optional
  future work; not implemented.
- Turnstile — optional; not implemented, and would need a secret and an owner
  decision.
- Backup, restore and disaster recovery — a Supabase project setting; see
  `OWNER_SETUP.md`.
- Data-retention enforcement — deliberately disabled with null durations until
  the owner records a policy. No duration has been invented.
