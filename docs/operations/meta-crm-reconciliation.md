# Vladimir Meta Ads ↔ CRM reconciliation

## Sources and consent boundaries

- Meta account: `act_2128002004809955`, currency GBP, IANA timezone `Africa/Cairo`. Verified through the connected Meta account on 2026-10-31.
- CRM canonical timestamps: `timestamptz` (UTC display), owner reporting timezone `Europe/London`.
- CRM source of truth: `public.enquiries`; explicit Meta-consented measurement records in `crm_private.enquiry_meta_attribution`.
- Browser/server Meta Lead `eventID` = CRM enquiry idempotency UUID. Meta's aggregate Insight count is **not** a per-customer acknowledgement.
- Enquiry-form paid social parameters must include `utm_source=fb|ig|facebook|instagram`, `utm_medium=paid`, `utm_campaign=<numeric campaign ID>`, `utm_term=<numeric ad set ID>`, `utm_content=<numeric ad ID>`.
- The configured Meta Ad *URL parameters* string should be:
  `utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`.
- URL parameters must be configured in Meta Ads Manager before activating new creatives. The connected Meta Analytics API currently cannot read or update an ad's URL-parameters setting, and its server-side writes were disabled when checked on 2026-10-31; these are separate release blockers.

## Run a read-only CRM-side reconciliation

This query is intended for an authorised backend database operator. It must not be embedded directly in the public site or exposed as unrestricted SQL from the GPT/MCP bridge.

```sql
select
  meta_account_event_date,
  ad_account_id,
  campaign_id,
  adset_id,
  ad_id,
  ad_identity_source,
  count(*)::integer as consented_crm_leads,
  count(*) filter (where capi_outbox_status = 'succeeded')::integer as capi_delivery_acks,
  count(*) filter (where time_basis = 'crm_created_at_fallback')::integer as crm_time_fallbacks
from crm_private.meta_enquiry_reconciliation
where artist_id = (select id from public.artists where slug = 'vladimir')
  and meta_account_event_date >= date '2026-10-01'
  and meta_account_event_date < date '2026-11-01'
  and campaign_id is not null
group by 1,2,3,4,5,6
order by 1,3,5;
```

For date filters in another month, replace both literals. Count `conversion_utm`, `last_touch_utm`, and `first_touch_utm` separately if acquisition-source semantics matter; first touch must not be presented as an ad-attributed Meta conversion.

## Match against Meta Insight

1. Use `meta_get_insights` for `act_2128002004809955`, `level='ad'`, `time_increment='1'`, `action_report_time='conversion'`, and the same **Meta-local** date range.
2. Filter to the desired conversion event/action type `Lead`; do not sum other actions with leads. Account for Meta attribution windows and ongoing reporting latency.
3. Group by actual Meta ad id and date; compare to CRM `meta_account_event_date`. Never join by raw London calendar date.
4. Label the two numbers separately: **Meta-attributed Lead** (provider model), **CRM enquiry with paid UTM ID** (first-party observed link). They can legitimately differ.
5. To confirm CAPI delivery, inspect `capi_outbox_status`; `succeeded` means provider acknowledged the batch, **not** that Meta attributed this lead to an ad. A browser/Meta CAPI deduplicated event can contribute one conversion.
6. When CRM has a Meta consent record but no complete paid UTM evidence, preserve `unknown` and do not invent a client ↔ ad match using `fbclid`, a referrer, or time proximity.
7. Exclude test enquiries and analytics-excluded records from business conversion-rate reporting according to existing reporting policy. The raw private view intentionally retains those consented rows for diagnostic integrity.

## Timezone example

`2026-10-24T22:30:00Z` is **24 Oct, London BST** and **25 Oct, Cairo**. The account-local date is used when comparing daily Insights. The offset between Cairo and London changes with DST; use IANA timezone conversion, never a fixed `+2 hours`.

## Rollout

- Draft PR must complete exact-head Static, Public/Worker, Private CRM and Supabase/pgTAP validation.
- Inspect migration ordering against the deployed schema and any concurrent lifecycle PRs.
- Use the approved CRM production migration/release workflow with owner-reviewed deployment readback. Do not directly execute an untracked DDL patch in production.
- After migration, verify private table row counts, account mapping, ad-ID provenance, zero source duplication and untouched `Lead` event ids.
- Confirm that the new paused Photo ad and future ads actually have the URL parameters before assuming customer-level ad correlation.
