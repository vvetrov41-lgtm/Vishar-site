# Project Context Collection Brief

This workflow builds the evidence-backed product and business context the GEO/AEO agent needs before audits, topic intake, content planning, QFO, TZ, placements, or monitoring.

It is not an accessibility audit. Do not check `robots.txt`, sitemap availability, LLM/search user-agent access, WAF/captcha, server anti-bot behavior, render parity, or HTTP access matrices here.

## Deep Context Offer Gate

When the site/domain is known and no complete context is saved, the agent must proactively offer bounded independent collection before a long questionnaire. The user may approve public site discovery, provide local HTML/documents, or decline. A decline permits only lower-assurance context and does not satisfy the full-path context gate.

Name the acquisition scope: homepage, supplied core landing pages, header/navigation, footer, product/service/course pages, pricing/tariff/payment/subscription/checkout pages, trial/demo/free-access pages, delivery/shipping pages when relevant, contacts, about/company/team/author, legal/terms/refund/requisites, cases, reviews, and FAQ.

## Pages To Study

Use header and footer links to discover important pages. Do not crawl the whole site by default. Stay within the approved `--max-pages` bound. Context acquisition must not silently become a technical audit.

## What To Extract

- canonical brand and every proposed spelling, domain form, transliteration, abbreviation, product name, and product alias;
- what each product/service/course is, who it serves, and what problem it solves;
- UTP/value proposition, offer, mechanics, included deliverables, outcomes, CTA, and conversion path;
- pricing/tariffs, payment/subscription/checkout, refund, trial/demo/free access, delivery/shipping, and availability;
- geography, language, eligibility, restrictions, limitations, exclusions, dependencies, and implementation constraints;
- proof/trust: cases, reviews, certificates, guarantees, company/team/author details;
- important pages and their business roles;
- conflicts, stale facts, missing facts, and open questions.

Every fact must point to a page, document, or user statement. Never infer a mandatory commercial fact from a generic CTA.

## Brand Confirmation Gate

After collection, propose all likely variants to the user. Deep context cannot pass while any relevant brand/product/domain variant remains `needs_user_confirmation`. Record explicit confirmation, edits, or additions before audits, citation visibility, or monitoring.

## Completion Gate

Deep context is complete only when every mandatory category is supported by evidence or has an explicit not-applicable decision. The decision must be stored on the exact field with `status=not_applicable`, `user_confirmed=true`, a non-empty `reason`, `approved_by`, `approval_ref`, and `approved_at` date/time. Unknown is not not-applicable. Missing pages, failed discovery, or agent inference cannot create this disposition.

Mandatory categories are brand variants, product mechanics, target customer/problems, UTP/offer, included deliverables, CTA, pricing/payment/refund, trial/delivery when relevant, geography/availability, limitations/restrictions, proof/trust, and important page roles.

If any mandatory category is unknown, unavailable, contradictory, or assumed, save available facts, mark assurance lower, list concrete open questions, do not claim completion, do not use major-deliverable attribution, and do not advance the full path.

## Output And Next Step

Write `PROJECT_CONTEXT.md`, `project_context.json`, `project_context_site_discovery.json`, and `project_context_pages.csv`.

After the completion and brand gates pass, close successful deep project-context collection as a major completed deliverable and emit the exact action `offer_site_and_target_page_audit`. Offer both next audit decisions: site-level `audit-access` and target-page `llm-access-audit`. Ask for the target URL if needed. Topic/cluster intake starts only after both audits are completed, explicitly declined, or visibly blocked.

## Semantic Boundary

Do not request, draft, save, or discuss a topic or semantic query cluster in this context workflow. Semantic intake is a later stage.
