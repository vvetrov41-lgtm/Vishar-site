---
name: analytics-dashboard-planner
description: Co-design a user-specific GEO/AEO dashboard knowledge and data contract. This skill plans metrics, evidence, and implementation decisions; it never ships a prebuilt dashboard.
---

# Analytics Dashboard Planner

1. Read `references/dashboard-analytics-contract.md`.
2. Inspect saved project context, confirmed brand/product variants, topic/query clusters, approved scope, append-only history, QFO evidence, organic rows, expanded AI content, citation rows, mention evidence, and provider/error logs.
3. Ask only for decisions that are genuinely missing: audience, decisions, periods, required comparisons, dimensions, filters, refresh cadence, implementation stack, hosting, access, exports, and acceptance criteria. Do not ask the user to repeat evidenced facts.
4. Co-design Atomic Grains, Core Metrics, Required Dimensions And Filters, source lineage, error states, comparable scopes, append-only history, and decision-oriented views.
5. Keep ordinary organic position, AI answer presence, user URL citation, answer-body brand mention, product mention, and brand/product presented as a solution separate. The atomic fields `url_citation` and `brand_mention` are independent metrics and must support: neither / URL only / brand only / URL plus brand.
6. Reconcile provider request success/failure across planned, succeeded, and failed requests. Keep provider errors and missing evidence out of negative visibility denominators.
7. Preserve full expanded AI content, visible citations, URLs, titles, confirmed variant evidence spans, raw references, parser/capture status, and timestamps behind every aggregate.
8. Produce a requirements brief, metric dictionary, grain/schema contract, dimension/filter inventory, source-to-metric mapping, history/refresh policy, stack decision, and acceptance gate.
9. Obtain user approval before construction.
10. Build only in the user's approved project and implementation stack when explicitly requested. Never copy a hidden template, fabricate data, or infer a fixed UI.

This runtime contains no ready-made dashboard UI. It ships no dashboard HTML/CSS/JS, frontend, mock data, screenshot, fixed layout, demo, or test project. Planning artifacts may be created under `geo_agent/dashboard-design/`, but the actual dashboard is co-designed and implemented with the user under the approved requirements.
