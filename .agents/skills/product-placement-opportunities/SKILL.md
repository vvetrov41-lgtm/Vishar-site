---
name: product-placement-opportunities
description: Generate external placement ideas for one query cluster where the user's product can naturally solve the searcher's problem. Use when the user asks where to place, mention, promote, advertise, seed, or include a product/brand in AI-cited, SERP-visible, review, comparison, forum, directory, or external publication sources.
---

# Product Placement Opportunities

Use this skill for one cluster at a time. Do not generate generic platforms first; start from the user problem and product fit.

## Procedure

1. Read `references/product-placement-opportunities-method.md`.
2. Confirm or infer:
   - cluster/topic;
   - cluster queries;
   - product or service;
   - target action;
   - GEO and language;
   - available SERP/AI/QFO evidence;
   - allowed or preferred platforms.
3. Run:
   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py find-placements --topic "<cluster>" --queries "<q1>; <q2>" --product "<product>" --target-action "<action>" --geo "<geo>" --language "<lang>"
   ```
4. If explicit evidence URLs are available, pass them:
   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py find-placements --topic "<cluster>" --serp-urls "<url1>; <url2>" --ai-urls "<url3>" --qfo-queries "<qfo1>; <qfo2>"
   ```
5. Inspect `geo_agent/reports/PLACEMENT_STRATEGY.md` and `geo_agent/data/processed/<topic>_placement_opportunities.csv`.

## Output Rules

- Return 10-30 ideas when evidence and fit allow it.
- Sort by `priority_score`.
- Keep `enter_existing` and `create_owned` separate.
- Show score components, not only the final score.
- Do not claim outreach was sent, placement was secured, or an owned external URL already exists.
- Downgrade low product-fit ideas instead of forcing the product into the topic.
- Use direct QFO only when the user supplied it explicitly; automatic QFO input may come only from `approved` or `externally_approved` content-plan rows. Never mine pending seeds, title semantics, clusters, or ChatGPT suggestions for placement evidence.

