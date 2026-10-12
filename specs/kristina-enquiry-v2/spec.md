# Kristina booking form on enquiry-v2

## Problem

kristinavishar.com still posts the legacy single-step payload. The CRM keeps
two intake shapes alive, Kristina's enquiries carry no structured
`project_details`, and her form cannot separate design references from photos
of an existing tattoo. The enquiry-v2 catalogue only knows Vladimir's realism
styles, so a v2 enquiry from Kristina would be recorded as "Colour realism".

Kristina's site has no privacy notice of its own. Her Worker sends
`2026-07-29`, a version that describes Vladimir's site.

## Required behaviour

1. The v2 catalogue gains Kristina's colour styles, marked `artist: kristina`:
   Floral / botanical, Watercolour, Custom colour, Miniature / small tattoo,
   Anime / cartoon, Micro-realism. Vladimir's styles and derivation are
   unchanged.
2. When any non-realism style is chosen, `project_type` is the chosen labels
   joined with ` + ` (max 100 chars). Cover-up, large placements and Not sure
   yet keep their existing precedence. Worker and SQL normaliser agree.
3. The operator editor offers the style set that matches the enquiry's current
   styles; RU labels exist for the new styles.
4. Privacy notice version `2026-10-12` (Kristina's own notice) is accepted by
   the Worker and the database intake gate. Earlier versions stay accepted.
5. The live Kristina contract probe follows whichever form the page declares
   (`data-form-schema="enquiry-v2"` or legacy), so TattooAI releases are not
   blocked by the order of the two repositories' deployments.
6. Artist routing is unchanged: Kristina's Worker forwards to TattooAI with the
   registry public source id; the database resolves source and Artist from
   that id and the exact Origin.

## Non-goals

- No per-source enforcement of style sets on the server. Any v2 form may send
  any catalogue style; each public form only shows its own artist's styles.
- No change to Vladimir's form, limits, image rules or idempotency.
- GA4 for kristinavishar.com is a separate stage.
