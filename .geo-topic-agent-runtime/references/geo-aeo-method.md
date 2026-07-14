# GEO/AEO Method

This reference is adapted from the existing GEO/AEO profile agent and the supplied one-topic agent brief.

## Core Model

AI search and answer engines usually involve separate layers:

1. ordinary SERP visibility;
2. retrieval or `search_results` candidate visibility;
3. final answer citation-source visibility;
4. answer-body brand mention.

Keep these signals separate. A project URL can appear in retrieval but not be cited. A brand can be mentioned without a URL. A URL can be cited without the target brand being recommended as the solution.

## Own Page Optimization

Prioritize:

- clear result-card promise: title, H1, description/snippet, URL path, intro;
- crawlable/fetchable HTML and visible main content;
- concise reusable answer modules;
- relevant chunks for the user task;
- page type and schema only when they match actual content;
- freshness only for topics where facts change;
- fan-out coverage without duplicate shallow pages.

Do not recommend tables, FAQ, schema, or E-E-A-T as universal fixes. Recommend them only when the evidence shows they help form an answer for the topic.

## Fan-Out / QFO

Fan-out is not raw keyword extraction. It asks which adjacent user tasks an AI system or searcher may explore before producing an answer.

Useful QFO branches often include:

- definition or short answer;
- comparison;
- cost;
- risks;
- alternatives;
- requirements;
- process or checklist;
- mistakes;
- examples;
- local/region-specific constraints.

Before recommending separate pages, check intent overlap. If branches solve the same task, use one stronger page or a hub section. Separate pages are justified when the user task, SERP pattern, or cited source pattern is materially different.

## External Placement

Prefer external URLs where:

- the URL/domain appears repeatedly in SERP or AI citation evidence;
- competitors are already mentioned;
- the page is relevant to the target task;
- the brand can be placed high in the main content;
- the page type has realistic editorial access;
- the URL is likely to stay indexed and visible.

Do not recommend low-quality package placements only because they accept posts. Visibility, relevance, citation usage, and mention placement matter more.

## Monitoring

Measure the same prompt/query, date, target GEO, user/search GEO, language, engine/model, and provider. Compare:

- project URL/domain in SERP;
- project URL/domain in retrieval/search_results;
- project URL/domain as final citation source;
- target URL match;
- answer-body brand mention;
- competitor source share;
- fan-out coverage.

One AI answer is not proof. Look for repeated signals across prompts, models, regions, and dates.

