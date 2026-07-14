# Product Placement Opportunities Method

This workflow finds external placement ideas for one query cluster where the project product can naturally appear as a solution to the user's problem.

It is not a generic "where can we place ads" generator. It must start from the cluster problem, then decide whether the product belongs in that user journey.

## Inputs

- cluster name or topic;
- cluster queries;
- product or service description;
- target action;
- GEO and language;
- SERP URLs or previously imported SERP rows;
- AI citation/source URLs or previously parsed AI rows;
- QFO or fan-out queries;
- allowed or preferred platforms/domains.

## Strategy Types

- `enter_existing`: get into an already visible or cited URL/domain.
- `create_owned`: create a new external material on a platform where publishing is realistic.

## Required Idea Fields

Each idea must include:

- `topic`;
- `product`;
- `strategy_type`;
- `platform_or_domain`;
- `content_format`;
- `placement_angle`;
- `why_user_would_need_product`;
- `expected_ai_signal`;
- `evidence`;
- `priority_score`;
- `effort`;
- `risk_or_limitation`.

## Scoring

Use a transparent 100-point score:

- product fit: 0-40;
- QFO/AI/SERP strength: 0-30;
- platform or domain value: 0-20;
- feasibility: 0-10.

## Quality Gate

Remove, block, or downgrade ideas when:

- the product is inserted artificially;
- the idea is based only on domain popularity;
- the platform does not match language or GEO;
- the format cannot create a plausible AI signal;
- the agent invents an already-published URL;
- the idea duplicates another idea without a new angle.

For `create_owned`, do not invent a final URL. Use platform/domain names and describe the asset to create.

For `enter_existing`, cite the existing source URL or domain from evidence when available.

