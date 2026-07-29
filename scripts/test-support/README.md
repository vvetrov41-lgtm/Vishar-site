# Local test shim

`supabase-shim.sql` emulates the parts of a hosted Supabase database that the
CRM migrations depend on, so `supabase/tests/*.sql` can run on a plain
PostgreSQL 16 cluster when Docker and the Supabase CLI are unavailable.

**The shim is a fallback test harness outside `supabase/tests/`. It is never
applied to a hosted database, and canonical `supabase test db` discovery cannot
load it** — the real platform already provides all of it.

Run it with:

```bash
npm run test:db          # scripts/run-crm-db-tests.sh
```

## What the shim provides

| Object | Why the migrations need it |
|---|---|
| roles `anon`, `authenticated`, `service_role` | grant/revoke targets in migration 0007 |
| Supabase `public` default privileges | new tables, sequences and functions initially granted to API roles, so migration 0001 must close them |
| schema `extensions` | `pgcrypto`, `citext` live there on Supabase |
| `auth.users` | `profiles.id` references it; bootstrap reads it |
| `auth.uid()`, `auth.role()` | every RLS policy and helper |
| `storage.buckets`, `storage.objects` with platform RLS enabled | the private bucket and its policies (0008) |
| extension `pgtap` | the test suite itself |

## Where the shim differs from hosted Supabase

These differences are the reason a shim-only pass must never be reported as a
hosted-Supabase pass.

| Difference | Direction | Effect on the tests |
|---|---|---|
| The migration owner is `NOSUPERUSER NOBYPASSRLS`; hosted `postgres` has `BYPASSRLS` | **stricter here** | `FORCE ROW LEVEL SECURITY` really does apply to SECURITY DEFINER functions, so the policies must be genuinely correct. A pass here implies a pass on Supabase. |
| `service_role` has no `BYPASSRLS`; on Supabase it does | **stricter here** | The Worker's intake path must satisfy real policies rather than bypassing them. |
| `storage.objects` has only the columns policy code touches | narrower | Nothing in migration 0008 references the omitted columns. |
| No PostgREST, no GoTrue, no Storage API | narrower | Tests set `request.jwt.claims` directly instead of presenting a JWT. Anything that depends on the HTTP layer — signed-URL minting, JWT expiry, the `authenticator` → `SET ROLE` hop — is **not** covered here. |
| No Storage upload/download path | narrower | Object rows are inserted directly. Real MIME sniffing and the bucket's `file_size_limit` enforcement are **not** exercised. |
| No `storage.protect_delete()` trigger | narrower | Database tests inspect delete policies and identity predicates but never treat direct SQL deletion as a Storage API test. |
| `auth.users` has three columns | narrower | Only `id` and `email` are used by the migrations. |
| PostgreSQL 16 locally; `supabase/config.toml` pins 15 for the local stack | minor | No migration uses a 16-only feature. |

## What is therefore NOT proven by a shim run

- signed-URL generation, expiry and revocation;
- Storage API-level MIME and size enforcement;
- Storage API deletion, including owner deletion and backend compensation;
- JWT issuance, expiry and refresh;
- PostgREST column-privilege error surfaces;
- anything about a hosted project, which does not exist.

Run `supabase test db` against a real local or staging stack before trusting
those.
