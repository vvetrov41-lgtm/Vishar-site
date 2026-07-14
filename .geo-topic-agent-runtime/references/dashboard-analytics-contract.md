# GEO/AEO Dashboard Knowledge And Data Contract

The runtime ships dashboard knowledge only. It ships no ready-made dashboard UI, frontend, HTML, CSS, JavaScript, screenshots, mock data, database, fixed layout, demo, or test project. The agent co-designs a project-specific dashboard with the user and implements it only after user approval of requirements and the implementation stack.

## Co-Design First

Ask only for decisions that cannot be derived from approved project context and evidence: dashboard audience, decisions to support, projects/topics, comparison periods, engines, region/city, language, device, provider, refresh cadence, target URLs, confirmed brand/product variants, hosting, access control, exports, implementation stack, and acceptance criteria. Do not ask the user to restate facts already evidenced. No construction starts before user approval.

## Atomic Grains

Keep complete atomic rows before aggregates. Minimum grains are:

- provider request: `run_id x request_id x query x engine x region x language x page`;
- organic result: `run_id x query x engine x region x language x rank x result_url`;
- AI answer: `run_id x query x engine x region x language x ai_answer_id`;
- AI citation: `run_id x ai_answer_id x cited_url`;
- brand/product mention: `run_id x ai_answer_id x confirmed_variant x evidence_span`;
- expanded AI capture: `run_id x ai_answer_id x expanded_ai_capture x raw_ref`.

Preserve provider request status/error/raw reference, organic title and URL, full expanded AI content, visible citations, cited URLs and titles, matched variants, evidence spans, parser state, and timestamps. Aggregates never replace these atomic grains.

## Core Metrics

Every metric defines its numerator, denominator, exclusions, source grain, compatible dimensions, and handling of errors:

- organic presence rate: eligible queries with at least one project URL in the requested organic depth / eligible queries;
- AI answer presence rate: eligible queries with an AI answer / eligible queries;
- project URL citation rate: eligible AI answers or eligible queries citing the project URL/domain / the explicitly chosen eligible denominator;
- brand/product mention rate: eligible AI answers or eligible queries containing a confirmed brand/product variant / the explicitly chosen eligible denominator;
- user URL citation: whether an eligible AI answer cites a URL owned by the user, recorded independently from any answer-body brand mention;
- answer-body brand mention: whether the expanded AI answer body contains a confirmed brand/product variant, recorded independently from any URL citation;
- brand/product presented as a solution: whether the answer body explicitly presents the confirmed brand or product as a solution to the user's problem, with an evidence span;
- ordinary SERP position and top-3/top-10/top-20 organic coverage;
- four-state split: neither / URL only / brand only / URL plus brand;
- unique cited URLs/domains, citation-source coverage, competitor/source citation share;
- provider request success/failure, with planned, succeeded, and failed provider requests reconciled so planned equals succeeded plus failed for a closed run;
- parser completeness, expanded AI content coverage, citation extraction coverage, raw evidence coverage, encoding failures, partial runs, and freshness.

Track `url_citation` and `brand_mention` independently. A URL citation does not imply a brand/product mention, and a brand/product mention does not imply a project URL citation. Provider errors and missing evidence are not negative visibility observations and are excluded from eligible denominators.

## Required Dimensions And Filters

At minimum support project, topic cluster, query, engine/search system, provider, region/country/city, language, device, run/date/time, comparison period, target URL/domain, organic result URL/domain, cited URL/domain, confirmed brand/product variant, four-state outcome, provider request status, parser/capture status, and evidence availability.

Filters and drill-downs must preserve exact scope and lead back to atomic evidence, including expanded AI content and raw references. Do not combine Google and Yandex or different regions/languages without an explicit labeled aggregate.

## History

The full measurement log is append-only. Every rerun gets a new `run_id`; previous observations and provider failures are never overwritten. Latest snapshots are convenience views only. Compare runs only when query universe, engines, region, language, device, provider, target definitions, depth, and AI scope are compatible.

## Co-Designed Outputs

Before implementation, produce an approved metric dictionary, atomic-grain schema, dimension/filter inventory, source-to-metric lineage, error-state contract, refresh/history policy, decision-oriented view list, implementation-stack decision, and acceptance checklist. The agent then builds only the approved project-specific construction in the user's project.

## Acceptance Gate

Requirements, decision use cases, metric definitions, Atomic Grains, Required Dimensions And Filters, implementation stack, access model, refresh policy, and acceptance criteria have user approval. `url_citation` and `brand_mention` remain independent; errors and timestamps are visible; full expanded AI content and source linkage are drillable; history is append-only; Unicode and count reconciliation pass; no test project, client data, credential, local path, fixture, or bundled UI ships.
