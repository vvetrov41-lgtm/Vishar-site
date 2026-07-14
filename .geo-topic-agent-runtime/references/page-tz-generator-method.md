# Page TZ Generator Method

This workflow creates a page-level technical specification from deterministic evidence, then leaves a short review surface for the agent to improve wording and flag weak evidence.

## Inputs

- Topic from the user.
- Previously parsed AI citations from the local project database/artifacts.
- Optional user-supplied competitor URLs.
- Optional local competitor content snapshots.
- For a QFO-derived page: the approved content-plan file, exact `page_id`, full title semantics evidence, and confirmed cluster query file. A direct quick run may use an explicit confirmed cluster without QFO.

## Competitor Selection

Use previous AI citations first. Search processed artifacts for citation URLs and titles, score them by topic overlap, source count, and AI-citation presence, then choose the top competitors. If no local citation evidence exists, use explicit `--competitor-urls`; otherwise the tool must report `quality_fail`.

## Content Extraction

For each selected competitor:

1. Prefer local content snapshots from `--competitor-content-dir` when present.
2. Use simple HTTP only when `--network-approved` is present.
3. Save raw content under `geo_agent/data/raw/pages/page_tz_<run_id>/`.
4. Strip scripts, styles, navigation, headers, footers, and obvious boilerplate.
5. Extract title, meta description, headings, main text, links, and commercial signals.

If simple HTTP fails or quality is weak, the agent should use a browser/manual collection path when available, save content as local HTML/TXT, and rerun with `--competitor-content-dir`.

## Parsing Quality

Every competitor gets a quality row:

- `pass`: enough text and headings were extracted.
- `warn`: content exists but is thin or missing headings.
- `blocked`: no usable content.

The generated TZ must show weak/blocked competitors. Do not silently ignore them.

## Deterministic Analysis

The generator must produce:

- competitor inventory;
- parsed content quality;
- balanced 1, 2, and 3-gram frequency table with document counts, larger bigram coverage, per-competitor density values, median density, and recommended occurrences per 1000 words;
- QFO title-semantics coverage from local QFO artifacts plus confirmed cluster query coverage from explicit input;
- page structure;
- required AI-citation chunks tied to the selected approved page and exact supporting title IDs;
- final clean copywriter-facing page TZ Markdown and JSON, with technical parser/QA notes separated into `PAGE_TZ_GENERATION.md`.

## Output Boundary

`PAGE_TZ.md` is a standalone brief for a copywriter or copywriter agent that does not share this chat context. It must not contain personal notes, parser statuses, raw refs, UI labels, service labels, or QA/debug comments. Those belong in `PAGE_TZ_GENERATION.md` or machine artifacts.

## Required TZ Contents

The final TZ must include:

- page goal and target intent;
- primary and secondary QFO title semantics plus confirmed cluster queries;
- competitor evidence summary;
- n-gram terms to cover naturally, including median competitor density and recommended occurrence range;
- recommended H1/H2/H3 structure;
- exact chunks to write, including a concise direct-answer chunk for AI extraction;
- commercial/decision blocks when relevant: price, service, comparison, criteria, examples, risks, FAQ;
- internal linking and schema notes;
- copywriter quality requirements that are useful for writing, not internal QA notes.
