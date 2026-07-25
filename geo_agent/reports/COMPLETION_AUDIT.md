# COMPLETION_AUDIT

Generated: 2026-07-25T18:56:53+00:00
Topic: Realism tattoo artist in Manchester and Salford
Status: block
Blocks: 7
Warnings: 3

| Requirement | Status | Evidence |
| --- | --- | --- |
| ADAPTATION_REPORT.md | pass | /home/user/Vishar-site/geo_agent/reports/ADAPTATION_REPORT.md |
| PROJECT_CONTEXT.md | pass | /home/user/Vishar-site/geo_agent/reports/PROJECT_CONTEXT.md |
| ACCESSIBILITY_AUDIT.md | pass | /home/user/Vishar-site/geo_agent/reports/ACCESSIBILITY_AUDIT.md |
| SERP_AI_ANALYSIS.md | block | missing |
| QFO_QUERY_ANALYSIS.md | pass | /home/user/Vishar-site/geo_agent/reports/QFO_QUERY_ANALYSIS.md |
| PAGE_TZ.md | block | missing |
| MONITORING_PLAN.md | pass | /home/user/Vishar-site/geo_agent/reports/MONITORING_PLAN.md |
| CITATION_VISIBILITY.md | block | missing |
| deep_project_context_quality_gate | pass | {"accepted_not_applicable_decisions": [], "accepted_not_applicable_fields": [], "brand_variants_confirmed": true, "brand_variants_status": "confirmed", "brand_variants_waivable": false, "material_open_questions": [], "missing_context_fields": [], "rejected_not_applicable_decisions": [], "site_context_status": "success", "status": "pass"} |
| qfo_agent_clustered_user_approved_content_plan | block | {"content_plan_approval": {"approval_ref": "", "source": "", "status": "pending_agent_and_user_approval"}, "path": "geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_analysis.json", "status": "quality_fail"} |
| page_tz_quality_gate | block | {"path": "geo_agent/data/quality-gates/realism-tattoo-artist-in-manchester-and-salford_page_tz_quality.json"} |
| citation_visibility_measured_log | block | {"measured_checks": 0, "path": "geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_citation_visibility_latest.json", "provider_error_checks": 0} |
| manual_or_live_serp_evidence | block | serp_rows=0, live_serp_rows=0 |
| manual_or_live_ai_answer_evidence | warn | ai_rows=0, live_ai_rows=0 |
| sqlite_storage | warn | missing |
| xmlriver_provider_audit | pass | /home/user/Vishar-site/geo_agent/data/processed/provider_audit.json |
| url_enrichment | warn | {"csv": "missing", "raw_files": 0, "raw_ref_errors": [], "report": "missing", "successful_rows": 0, "summary": "missing", "summary_errors": ["missing or empty URL enrichment summary"]} |
| placement_strategy_optional | pass | /home/user/Vishar-site/geo_agent/reports/PLACEMENT_STRATEGY.md |

## Claim Boundary

A pass here proves local runtime artifacts and storage exist. Live provider evidence is a separate warning/pass signal and must not be claimed when rows are zero.
