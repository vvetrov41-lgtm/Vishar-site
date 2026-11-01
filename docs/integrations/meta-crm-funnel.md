# Meta funnel endpoint for Vishar Meta Analytics

Producer: this repository, TattooAI Worker route `GET /internal/meta-funnel` (`workers/routes/meta-funnel.js`) and the database function `public.service_meta_crm_funnel(text, date, date)` (migration `20261101170000`).
Consumer: `vvetrov41-lgtm/vishar-meta-analytics`, tool `meta_get_funnel_report` (contract `docs/crm-funnel.md` there).

## Request

`GET /internal/meta-funnel?account_id=act_<digits>&since=YYYY-MM-DD&until=YYYY-MM-DD`

- `x-vishar-timestamp`: Unix seconds, at most 300 s from the Worker clock.
- `x-vishar-signature`: lowercase hex HMAC-SHA256 with the account's key over `vishar-crm-funnel\nv1\n<timestamp>\n<account_id>\n<since>\n<until>`.
- No other query parameter is accepted. There is no artist parameter: the database maps the ad account to one artist through `crm_private.meta_ad_account_identity`.
- Range: 90 days at most.

## Answers

| Case | Status |
|---|---|
| Valid signature | 200, JSON per the contract |
| Disabled, unknown account, bad or old signature, any other method or parameter | 404 `Not found`, no detail, no CORS |
| Database unavailable | 503 `crm_unavailable` |
| Database returned an unexpected shape | 502 `crm_invalid_response` |

## Data rules (enforced in SQL)

- Only consented Meta attribution rows (`crm_private.enquiry_meta_attribution` through `crm_private.meta_enquiry_reconciliation`) whose numeric ad ID came from paid UTM evidence are counted.
- Enquiries with `excluded_from_analytics` are removed.
- Grouping is by Meta account-local date (`meta_account_event_date`, IANA timezone from the registry) and ad ID.
- The metrics are:
  - `enquiries`;
  - `consultations`: confirmed or completed consultation appointments;
  - `confirmed_projects`: project `active` or `completed`;
  - `deposits_count` and `deposits_minor`: project deposit `paid`, GBP only.
- Counts of 1 or 2 are returned as `null`. The deposit total is null with its count.
- No names, emails, phones, enquiry IDs, references or free text are returned. The Worker rebuilds every row from the listed fields only.

## Configuration (owner action, not done by code)

- **TattooAI Worker secret `META_FUNNEL_KEYS`:** `{"act_2128002004809955":"<at least 32 random characters>"}`. Without it, the route answers 404.
- **Meta Analytics Worker:**
  - variable `CRM_FUNNEL_URL` = `https://<TattooAI host>/internal/meta-funnel`;
  - secret `CRM_FUNNEL_KEYS` with the same key.
- **Database:** the migration reaches production only through the private production release workflow from an exact SHA, after PR #1133's migration.
