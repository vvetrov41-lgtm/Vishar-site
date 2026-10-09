# Plan

| Layer | Change |
|---|---|
| Database | `20261009160000_structured_enquiry_intake_v2.sql`: `enquiries.project_details jsonb`, `enquiry_files.intake_role`, ordinals 0–5, intake accepts 1–6 files, email optional only for WhatsApp-first with an E.164 phone. Column grants for `authenticated`. Legacy payloads keep their fingerprint. |
| Worker | `workers/lib/enquiry-v2.js` validates the catalogue in `config/enquiry-form-v2.json`, derives `project_type`, `placement`, `approximate_size`, `cover_up`, and computes image requirements. `validation.js` routes `formSchema=enquiry-v2`; legacy limits unchanged. |
| CRM | `EnquiryProjectDetails` on the enquiry page; images grouped by role. |
| Website (main) | `assets/js/enquiry-form-v2.js`, `assets/css/enquiry-form-v2.css`, booking page flag and shared measurement API. |

Release order: database, then tattooai Worker, then operator CRM, then the
website with the flag on `legacy`, verification through the override, then the
flag flip. Rollback: set the flag to `legacy`; the backend stays compatible.
