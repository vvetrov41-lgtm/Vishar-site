# PAGE_TZ_GENERATION

Generated: 2026-07-26T05:05:25+00:00
Topic: Cover-up tattoo Manchester

## Counts

- Competitors selected: 21
- Parse pass/warn: 12
- Parse blocked: 9
- N-grams total: 150
- 1-grams: 40
- 2-grams: 70
- 3-grams: 40
- N-gram density fields: median_density_pct, recommended_density_pct, recommended_occurrences_per_1000_words
- Chunks: 5

## Output Boundary

- PAGE_TZ.md is the clean copywriter-facing brief.
- Parser statuses, weak competitor notes, raw refs, and QA comments stay in this generation report or CSV/JSON artifacts, not in the copywriter brief.

## Artifacts

- competitors: geo_agent/data/processed/cover-up-tattoo-manchester_tz_competitors.csv
- quality: geo_agent/data/processed/cover-up-tattoo-manchester_tz_content_quality.csv
- ngrams: geo_agent/data/processed/cover-up-tattoo-manchester_tz_ngrams.csv
- chunks: geo_agent/data/processed/cover-up-tattoo-manchester_tz_chunks.csv
- json: geo_agent/data/processed/cover-up-tattoo-manchester_page_tz.json
- page_tz: geo_agent/reports/PAGE_TZ.md
- quality_gate: geo_agent/data/quality-gates/cover-up-tattoo-manchester_page_tz_quality.json

## Quality Notes

- cmp_002 google.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_003 gstatic.com: blocked - UnicodeError: Unable to decode https://www.gstatic.com/share/gradient_g_250_250.png without data loss (utf-8-sig:UnicodeDecodeError, utf-8:UnicodeDecodeError, cp1251:UnicodeDecodeError).
- cmp_004 instagram.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_005 instagram.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_006 instagram.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_007 keepthefaithtattoo.co.uk: blocked - collect_with_browser_or_provide_snapshot
- cmp_008 keepthefaithtattoo.co.uk: warn - use_content
- cmp_009 lastsuppertattoos.co.uk: warn - use_content
- cmp_010 lastsuppertattoos.co.uk: blocked - collect_with_browser_or_provide_snapshot
- cmp_016 reddit.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_017 reddit.com: blocked - collect_with_browser_or_provide_snapshot
- cmp_019 tattoodo.com: warn - use_content

## Agent Curation Of This TZ

`PAGE_TZ.md` is not the generator's raw output. The raw brief was rejected and
rewritten; this section records why, so the deliverable stays auditable.

### Why the first two generator runs were discarded

- The competitor selector ranks candidates by token overlap against the topic
  string. Rows harvested from AI-citation history score on title plus prompt
  plus domain, while URLs passed through `--competitor-urls` score on the URL
  string alone. The explicitly supplied cover-up pages therefore sorted below
  the harvested rows and were cut by `--max-competitors`.
- Run 1 (`--max-competitors 4`) consequently analysed `google.com`, the
  `gstatic.com` gradient PNG, the bare `instagram.com` root and one studio
  homepage. One of four parsed, and it was not a cover-up page.
- Run 2 (`--max-competitors 28`) reached 12 parsed pages but pulled in
  `policies.google.com/privacy` at 8,981 words - by far the largest document in
  the set. Median n-gram density computed across that set is not a description
  of cover-up pages.

### How the accepted evidence was produced

A third run was executed against an isolated project copy under
`.geo-agent-local/claude/tz-clean/` with the AI-citation CSVs removed, so
selection fell back to the five explicitly curated cover-up URLs. Nothing in
the tracked project was mutated to achieve this.

| URL | Parse | Words |
| --- | --- | --- |
| `lbltattoo.co.uk/tattoo-cover-up` | pass | 2430 |
| `noregrets.tattoo/uk/tattoo-cover-ups-transforming-regret-into-redemption/` | pass | 1212 |
| `tattoodo.com/tattoo-artists/manchester/artists/cover-up-32` | warn | 238 |
| `lastsuppertattoos.co.uk/cover-ups/` | blocked | 12 |
| `fleshtattoo.co.uk/tattoos/` | blocked | 0 |

Two pages carry the analysis. `lastsuppertattoos.co.uk/cover-ups/` is the most
relevant competitor of all - it ranks first organically for
`tattoo cover up Manchester` and is AI-cited - and it could not be parsed by
plain HTTP. Browser-based collection is unavailable in this environment because
Chromium cannot route through the agent proxy. That page is a known gap in this
brief, not an omission.

### Generator n-gram output was not used verbatim

The density table contained scraped interface chrome and unrelated proper nouns
from the Tattoodo directory page - `caption here`, `slide title`,
`button slide`, `klarna available`, `phillip wilkinson`, `rambo manchester`,
`heatons tattoo`, `soul ink` - several recommended at up to 52 occurrences per
1,000 words. Following that table would damage the page. The legitimate subset
(`old tattoo`, `tattoo cover`, `cover ups`, `old ink`, `existing tattoo`,
`successful cover`, `new design`) was carried into `PAGE_TZ.md` as concept
coverage rather than as occurrence counts.

The generator also proposed retitling the page to
"Cover-up tattoo Manchester: guide, comparison, and decision criteria" and
emitted five chunk sections that repeated one identical term list. Both were
dropped: the approved content plan is to strengthen the existing page, and the
existing title already carries service plus city.

### Coverage gaps in `PAGE_TZ.md` come from competitor structure

Headings extracted from the two parsed competitors, compared against the
existing page's own headings, produced the four gap modules in the brief. The
laser-removal decision module is the clearest absence: both cited competitors
address it and the current page does not.

### Evidence boundary

This brief rests on one query's AI answer plus organic evidence for the
cover-up cluster. It says nothing about the realism, portrait or consultation
queries, and it is not a site-wide content strategy.
