# Product Slice: Project Web References

## Purpose

Project Web References is the first persistent CRM product slice built on the Web Research gateway. It turns a public URL attached to a tattoo project into a structured, source-backed reference that the artist can review without repeatedly opening and interpreting each page manually.

This slice is intentionally different from generic workspace Research. A project web reference belongs to a specific tattoo project and follows the existing authorization for that project. Firecrawl remains only a public-web provider behind Vishar's server-side Research gateway.

## Product flow

```text
Tattoo project
    |
    +-- Web References
            |
            +-- Add public URL
                    |
                    -> Vishar Research gateway
                    -> Firecrawl Scrape/read operation
                    -> tattoo-reference extraction schema
                    -> normalized public-source snapshot
                    -> project web-reference record
                    -> artist review / notes / decisions
```

The CRM should show a new `Web References` section in the project surface alongside the project's existing reference material. Adding a URL creates a visible pending item immediately; provider processing may finish asynchronously.

## MVP behavior

An authorized artist can:

1. add one public `http`/`https` URL to a tattoo project;
2. see pending, ready or failed analysis state without blocking the rest of the project UI;
3. reopen the original public source;
4. review a stable normalized tattoo-reference analysis;
5. add or edit artist-owned notes independently from source analysis;
6. mark extracted ideas as use, ignore or change where the UI supports structured decisions;
7. manually reanalyse a source without overwriting the prior successful evidence needed for audit/history;
8. remove the project association without corrupting shared/cached public-source evidence;
9. see project activity entries for add, analyse, reanalyse, failure and removal events.

Provider failure must never make the tattoo project unavailable. The reference remains visible with an explicit failed state and a retry/reanalyse action.

## Tattoo-reference extraction contract

The provider-neutral extraction result should support at least:

```text
summary
subjects[]
visual_style
colour_palette[]
composition
lighting
useful_tattoo_details[]
source_title
source_url
retrieved_at
```

Exact JSON/TypeScript field names may change during implementation, but the semantic fields must remain stable enough for multiple URLs in one project to be compared using the same schema.

The extraction describes the public source. It does not become authoritative client intent and must not be copied into project requirements as if the client explicitly requested every detected element.

## Source analysis versus artist decisions

The product must keep two concepts separate:

```text
SOURCE ANALYSIS
What the public reference contains.

ARTIST DECISION
What the artist intends to use, ignore or change.
```

Artist-owned notes/decisions are mutable CRM data. Source analysis is provider-derived public evidence and should retain enough history to distinguish a later reanalysis from the result the artist originally reviewed.

A practical example:

```text
Source analysis:
- female portrait
- sword
- flowers
- red rim light

Artist decision:
- use portrait
- use sword
- ignore flowers
- change red rim light to cold blue
```

## Multiple-reference synthesis

After individual-reference behavior is proven, one tattoo project may synthesize several ready web references into a project-level summary. This is the next product increment, not a prerequisite for adding the first URL.

The synthesis should identify repeated and divergent visual signals, for example:

```text
Repeated motifs
- female portrait: 5/6 references
- dark background: 6/6
- side lighting: 4/6
- saturated red accent: 3/6
```

The synthesis is advisory. It must never silently rewrite client notes, artist notes, scope, quote, session count or booking state.

Only normalized public-source analysis may be used as the external-research input. Client names, contact information, private project notes, uploaded private images, messages, finance and other CRM-private content must not be sent to Firecrawl for synthesis or extraction.

## Authorization and ownership

Project Web References are artist/project-scoped CRM data, not generic workspace Research records from a user's perspective.

Required invariants:

- adding, reading, reanalysing, editing artist notes or removing a project web reference requires current authorization to the parent tattoo project;
- a workspace-level `view_research` or `run_research` capability alone must not reveal another artist's tattoo projects or project web references;
- a project web-reference relation must never become a path for broad workspace Research access to private client/project fields;
- project/client identifiers stay inside Vishar and are never provider request fields;
- the outbound provider request contains only the canonical public URL, public extraction definition and strictly required provider-control metadata;
- revoking access to the parent project immediately revokes access to its web references, even when the underlying public source is present in a shared provider cache.

The implementation may reuse provider-neutral `research_sources` / `research_snapshots` primitives internally, but the authorization join from a project reference to those primitives must be server-enforced and must not widen project access.

## Persistence shape

Exact schema is deferred to the Phase W fresh-check. The logical product concepts are:

```text
project_web_reference
- parent project
- canonical public URL/source identity
- processing state
- latest successful source snapshot pointer
- created/reanalysed timestamps
- artist notes / structured decisions

public source snapshot
- normalized tattoo-reference extraction
- retrieval metadata
- immutable or append-only successful evidence
```

A canonical URL may be cached or deduplicated at the public-source layer. That must not deduplicate away project-specific artist notes, decisions, ownership or activity history.

## Cache and reanalysis

Equivalent public URL + extraction-schema requests may use the existing bounded Research cache.

MVP rules:

- cache hit is allowed for the provider-derived source analysis;
- project authorization is always checked independently of cache state;
- `Reanalyse` explicitly requests a fresh provider fetch when provider policy/limits permit;
- provider failure during reanalysis preserves the last successful analysis and records the failed attempt;
- a stale or failed analysis must never be presented as newly verified.

## Activity and audit

Record bounded project activity events such as:

```text
web_reference_added
web_reference_analysis_succeeded
web_reference_analysis_failed
web_reference_reanalysed
web_reference_removed
```

Activity entries may identify the CRM project internally, but must not copy raw scraped page bodies into general activity logs.

## UI acceptance

The first usable CRM slice is complete when an authorized artist can open a real tattoo project and:

1. add a public URL in `Web References`;
2. continue using the project while the item is pending;
3. see explicit ready/failed state;
4. review `summary`, subjects, visual style, colour palette, composition, lighting and useful tattoo details with the source URL;
5. enter separate artist notes/decisions;
6. reanalyse the URL while preserving the last successful result if the new fetch fails;
7. lose access immediately when access to the parent project is revoked;
8. prove through provider-request inspection that no private client/project data was sent to Firecrawl.

## Priority relative to generic Research

After the transient Phase V gateway is accepted, Project Web References is the preferred first persistent CRM-facing value slice. Generic workspace Research for Competitors, Studios, Pricing, SEO and Market research remains in scope, but it should not block this project workflow and should not be treated as the only Phase W product surface.

Implementation may share the same persistence primitives if that reduces duplication safely. The release sequence should prove Project Web References before or alongside the first generic Research UI, then add multi-reference synthesis after single-reference acceptance is stable.
