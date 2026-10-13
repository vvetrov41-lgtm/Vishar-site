# Plan

| Layer | Change |
|---|---|
| Catalogue | `config/enquiry-form-v2.json`: six Kristina styles with `artist: "kristina"`. |
| Database | `20261012120000_enquiry_v2_kristina_styles.sql` redefines `crm_private.enquiry_v2_catalogue()` and `crm_private.normalise_enquiry_project_input()`; `20261012120100_kristina_privacy_notice_20261012.sql` widens the intake privacy gate fail-closed. |
| Worker | `deriveLegacyFields` joins non-realism labels; `validation.js` accepts `2026-10-12`. |
| CRM | RU labels; `stylesFor()` picks the artist style set in the structured editor. |
| Probe | `probe-kristina-live-booking-contract.mjs` accepts legacy and v2 pages, checks every local script, sends the matching payload with a non-image file. |
| kisa | Simple single-page v2 form, privacy notice `/privacy/`, `CRM_PRIVACY_NOTICE_VERSION=2026-10-12`. |

Release order: database, TattooAI Worker, operator CRM, then kisa. The probe
runs against the live legacy page during the TattooAI release; after the kisa
deploy it runs again in v2 mode as production acceptance without persistence.
Rollback for kisa is redeploying the previous Worker version; the CRM stays
compatible with both payloads.
