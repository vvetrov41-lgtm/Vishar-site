# Tasks

- [x] Phase 1 migration, pgTAP, Worker hook, tests
- [x] Release database (dispatch, `cf196fe9`) and TattooAI Worker (`cf196fe9`, version `f7ef3a43`); production readback 2026-10-13: first scheduled run 23:05:44 UTC, 86 enquiries, 0 candidates (recent_activity 69, converted_to_project 10, client_has_commercial_records 4, has_session 3), enquiry and file counts unchanged (86 / 127), next tick throttled
- [ ] Phase 2 executor (separate PR) before the first `retention.candidates_found`
