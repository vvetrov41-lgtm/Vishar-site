# Semantic SEO TZ Handoff

Create a structured handoff that a semantic TZ or brief generator can consume after the GEO/AEO topic workflow. The handoff is a transfer artifact: it carries evidence, decisions, and constraints from the GEO/AEO analysis, and it is not itself a completed TZ unless an approved generator is invoked and produces an output file.

## Discovery

During `setup`, search the current project for available semantic TZ or brief generator entrypoints:

- `semantic_brief_builder.py`
- `tz_generator`
- `brief_generator`
- `content_brief`
- `semantic_seo`
- `seomeat`

If a generator is found, record:

- path or command name;
- expected invocation if detectable;
- whether the command is local-only or may use network;
- expected input and output format.

## Handoff JSON

Write `data/handoff/semantic_tz_handoff_<topic>.json` with:

- project domain and brand;
- topic;
- region/language/search engines;
- user goal: `url_citation`, `brand_as_solution`, or `both`;
- fan-out queries;
- source SERP rows;
- AI answer citation rows when available;
- title/H1/snippet patterns;
- intent clusters;
- content plan items;
- placement opportunities;
- monitoring prompts;
- assumptions and skipped evidence.

## Quality Rules

- Do not call a handoff "generated TZ" unless the semantic generator was actually invoked and its output exists.
- Do not hide skipped SERP, AI-answer, or competitor evidence.
- Do not pass raw provider secrets or `.env` contents.
- Do not lower generated semantic phrase DF thresholds in the semantic SEO generator.
- Preserve full source rows in CSV/JSONL where possible; summaries are for humans, not downstream source of truth.
- Generated content instructions must separate facts, hypotheses, and recommendations.

