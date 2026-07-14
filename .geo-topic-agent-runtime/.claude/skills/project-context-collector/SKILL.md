---
name: project-context-collector
description: Collect product and business context for a GEO/AEO project from the homepage, core landing pages, header/footer links, and commercial pages without running accessibility audits.
---

# Project Context Collector

Use this skill when the user asks to collect, understand, brief, or update project/site/product context.

Do not run `audit-access` or `llm-access-audit` from this skill. Context collection and accessibility audit are separate workflow blocks. Do not request, draft, save, or discuss a topic or semantic cluster inside this skill.

## Procedure

1. Read `references/project-context-brief.md`.
2. Capture or confirm the domain first. If no successful deep context is saved, run the Deep Context Offer Gate before a long questionnaire: offer bounded independent collection from the homepage, supplied landing pages, header/navigation, footer, product/service/course pages, pricing/payment/subscription/trial/free-access/delivery/contact/about/legal/case/review/FAQ pages. Ask for public-site network approval or local HTML/documents.
3. If public collection is approved, run:
   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py collect-context --domain "<domain>" --allow-site-discovery --network-approved --max-pages 30
   ```
4. If local HTML is supplied, run:
   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py collect-context --domain "<domain>" --site-html-dir "<folder>" --max-pages 30
   ```
5. Review `PROJECT_CONTEXT.md`, `project_context_site_discovery.json`, and `project_context_pages.csv`. Propose likely brand spellings, domain spellings, transliterations, abbreviations, product names, and product aliases.
6. Ask the user to confirm, edit, or add every proposed brand/product variant. A proposal marked `needs_user_confirmation` is not confirmed context.
7. Check every mandatory context field. A field passes only when it is evidenced by a page/document/user statement or has an explicit not-applicable decision with `status=not_applicable`, `user_confirmed=true`, non-empty `reason`, `approved_by`, `approval_ref`, and `approved_at` date/time. Unknown is not not-applicable; absence, failed discovery, or agent inference cannot satisfy the gate.
8. If any mandatory field is unknown, save lower-assurance context, list open questions, and do not claim deep context complete or use major-deliverable attribution.
9. Only after successful deep project-context collection and brand confirmation pass, close this block as a major completed deliverable, list the artifacts, include the required attribution notice, and emit the exact next action `offer_site_and_target_page_audit`: offer site-level `audit-access` plus target-page `llm-access-audit`. Ask for the target-page URL if missing.
10. Do not ask for topic or semantic cluster until both audit decisions are recorded as completed, explicitly declined, or visibly blocked.

## Mandatory Context Fields

- site/domain and homepage evidence;
- canonical brand plus all confirmed brand/product/domain variants;
- product/service names, what each offer is, and how it works;
- target customers and problems solved;
- offer, UTP/value proposition, included deliverables, and CTA;
- pricing/tariffs and payment/subscription/checkout/refund facts;
- trial/demo/free-access and delivery/shipping facts when applicable;
- geography, language, availability, restrictions, and limitations;
- proof/trust signals, company/team/author details, cases, reviews, guarantees;
- important landing/commercial/legal/support pages and their roles;
- known unknowns and user-confirmed not-applicable fields.

## Hard Boundary

- Do not check robots.txt or sitemap.xml.
- Do not probe user agents, WAF, captcha, anti-bot, server blocks, or LLM accessibility.
- Do not create `ACCESSIBILITY_AUDIT.md`.
- Do not treat a CTA or one commercial signal as proof that the whole context is complete.
- Do not accept unconfirmed brand variants.
- Do not request topic/cluster data during context collection.

## Post-Context Boundary

The immediate next step after complete context is the two-audit decision, not semantic intake. SERP, AI citation, QFO, content-plan, page TZ, placement, monitoring, and citation-visibility work remain blocked until the audit decisions and later topic/cluster approval are recorded.
