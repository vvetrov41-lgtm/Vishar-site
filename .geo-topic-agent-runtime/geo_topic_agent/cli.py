from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .core import (
    audit_accessibility,
    collect_project_context,
    confirm_brand_variants,
    collect_serp,
    completion_audit,
    enrich_urls,
    final_evidence_audit,
    final_evidence_readiness,
    find_placements,
    generate_tz_handoff,
    init_project_context,
    independent_audit_pack,
    install_runtime,
    invoke_tz_generator,
    monitor_plan,
    record_final_evidence_descope,
    record_audit_decision,
    provider_audit,
    run_topic_workflow,
    setup_environment,
)
from .llm_accessibility import llm_accessibility_audit
from .qfo_analysis import qfo_query_analysis
from .citation_visibility import citation_visibility_audit
from .tz_page_generator import generate_page_tz


def configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="geo-agent", description="One-topic GEO/AEO workflow agent.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("install", help="Verify the extracted runtime and install it into a separate target project without overwriting project files.")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--runtime", default="auto", choices=["auto", "codex", "claude", "cursor", "opencode", "antigravity", "generic", "cli", "node"])
    p.add_argument("--install-native-adapter", action="store_true", help="Install the native entrypoint only when no conflicting project file exists; collisions are never overwritten.")

    p = sub.add_parser("setup", help="Adapt to the current project and discover existing tools.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--scan-neighbors", action="store_true")
    p.add_argument("--runtime", default="auto", choices=["auto", "codex", "claude", "cursor", "opencode", "antigravity", "generic", "cli", "node"])
    p.add_argument("--apply-runtime-adaptation", action="store_true")
    p.add_argument("--reviewed-runtime-plan-hash", default="", help="Required for --apply-runtime-adaptation; must equal the plan_hash from the prior setup output.")

    p = sub.add_parser("init-project", help="Capture manual project context fields without site audit.")
    add_context_args(p)

    p = sub.add_parser("collect-context", help="Collect product/site context from homepage, landing pages, header/footer, and commercial pages without accessibility audit.")
    add_context_args(p)
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--site-html-dir", default="")
    p.add_argument("--max-pages", type=int, default=30)
    p.add_argument("--timeout", type=int, default=12)


    p = sub.add_parser("confirm-brand-variants", help="Record explicit user confirmation for the complete brand variant set.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--brand-variants", default="", help="Optional complete replacement set; omitted values confirm the saved proposed set.")
    p.add_argument("--confirmation-ref", required=True, help="User-visible approval reference, ticket, or message identifier.")
    p.add_argument("--confirmed-by", required=True, help="Person or accountable role that confirmed the variants.")

    p = sub.add_parser("audit-access", help="Prepare or run accessibility audit.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--domain", default="")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--timeout", type=int, default=12)

    p = sub.add_parser("llm-access-audit", help="Audit one page for LLM/search/agent accessibility.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--url", required=True)
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--render", action="store_true")
    p.add_argument("--timeout", type=int, default=20)


    p = sub.add_parser("record-audit-decision", help="Record an explicit declined or blocked decision for a mandatory audit through the public contract.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--audit-id", required=True, choices=["site_accessibility", "target_page_llm_accessibility"])
    p.add_argument("--decision", required=True, choices=["declined", "blocked"])
    p.add_argument("--reason", required=True)
    p.add_argument("--decided-by", required=True)
    p.add_argument("--decision-ref", required=True)
    p.add_argument("--decided-at", default="")

    p = sub.add_parser("provider-audit", help="Audit provider credentials and implemented adapters without live calls.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--provider", default="all")
    p.add_argument("--env", default="")

    p = sub.add_parser("collect-serp", help="Plan or run approved live SERP collection.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", required=True)
    p.add_argument("--provider", default="xmlriver", choices=["xmlriver", "dataforseo"])
    p.add_argument("--engines", default="google,yandex", help="Comma-separated search engines. XMLRiver supports google,yandex; DataForSEO adapter currently supports google.")
    p.add_argument("--region", default="RU-Moscow", help="Region alias or numeric ID. XMLRiver Google uses loc from https://xmlriver.com/files/geo.csv; Yandex uses numeric lr region id.")
    p.add_argument("--language", default="ru", help="Language code. XMLRiver Google sends lr=<code>; XMLRiver Yandex sends lang=<code>.")
    p.add_argument("--cluster-queries", default="", help="Semicolon/comma/newline separated user semantic cluster queries for this topic.")
    p.add_argument("--cluster-queries-file", default="", help="TXT or CSV file with semantic cluster queries.")
    p.add_argument("--seed-queries", default="", help="Legacy alias for --cluster-queries; do not use as a separate query source.")
    p.add_argument("--depth", type=int, default=20, help="Top-N organic URLs to collect per query/engine, not pagination pages. XMLRiver returns 10 URLs per SERP page, so depth 100 = 10 paid page requests per query/engine.")
    p.add_argument("--max-queries", type=int, default=0, help="0 means all cluster queries; positive values intentionally cap the cluster.")
    p.add_argument("--include-ai", action="store_true")
    p.add_argument("--load-async-ai-overview", action="store_true")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--paid-approved", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--quick-cluster-mode", action="store_true", help="Explicit isolated QFO/SERP research mode: requires a user-supplied cluster and does not replace context or audit workflow.")
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--env", default="")
    p = sub.add_parser("qfo-analyze", help="Analyze a user query batch through XMLRiver AI SERP evidence and build QFO content plan.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--queries", default="")
    p.add_argument("--queries-file", default="")
    p.add_argument("--engines", default="", help="Comma-separated XMLRiver engines. Omit only when an authoritative saved project scope exists; Google and Yandex are supported.")
    p.add_argument("--region", default="", help="Region alias or provider IDs (google=<loc>;yandex=<lr>). Omit only when an authoritative saved project scope exists.")
    p.add_argument("--language", default="", help="Language code. Omit only when an authoritative saved project scope exists.")
    p.add_argument("--depth", type=int, default=None, help="Top-N organic URL count per query/engine, not pagination pages. Omit only when an authoritative saved project scope exists.")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--paid-approved", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="Resolve scope and emit the exact reviewed plan hash without making paid requests.")
    p.add_argument("--approval-ref", default="", help="Exact external approval-ledger reference for the reviewed paid XMLRiver plan.")
    p.add_argument("--reviewed-plan-hash", default="", help="SHA-256 shown by dry-run; must match the invocation and approval ledger exactly.")
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--env", default="")
    p.add_argument("--chatgpt-qfo-file", default="")
    p.add_argument("--selected-themes", default="", help="Legacy filter for the pending title workpack; it does not approve a content plan.")
    p.add_argument("--approved-content-plan-file", default="", help="CSV/JSON agent-clustered content plan with full title disposition. Approval must be external and hash-bound.")
    p.add_argument("--content-plan-approval-ref", default="", help="Exact external approval-ledger reference bound to the content-plan and title-inventory hashes.")
    p.add_argument("--reuse-existing-evidence", action="store_true", help="Reuse a same-run QFO evidence manifest after verifying scope and all raw/processed hashes; makes zero paid requests.")
    p.add_argument("--evidence-manifest", default="", help="Optional explicit same-run QFO evidence manifest. Defaults to the canonical topic manifest.")
    p.add_argument("--quick-cluster-mode", action="store_true", help="Explicit isolated QFO research mode using only the user-supplied query cluster.")
    p = sub.add_parser("citation-visibility", help="Measure organic SERP position and AI citation visibility for queries.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--domain", default="")
    p.add_argument("--brand", default="")
    p.add_argument("--brand-variants", default="", help="Semicolon/comma/newline separated confirmed brand spellings, aliases, transliterations, domain spellings, and product aliases used for AI answer body mention tracking.")
    p.add_argument("--products", default="")
    p.add_argument("--queries", default="")
    p.add_argument("--queries-file", default="")
    p.add_argument("--serp-csv", default="")
    p.add_argument("--ai-csv", default="")
    p.add_argument("--engines", default="google,yandex", help="Comma-separated search engines. XMLRiver supports google,yandex; DataForSEO adapter currently supports google.")
    p.add_argument("--regions", default="RU-Moscow", help="Semicolon/comma separated regions; live XMLRiver uses explicit region params per references/xmlriver-serp-method.md.")
    p.add_argument("--language", default="ru", help="Language code. XMLRiver Google sends lr=<code>; XMLRiver Yandex sends lang=<code>.")
    p.add_argument("--provider", default="xmlriver", choices=["xmlriver", "dataforseo"])
    p.add_argument("--depth", type=int, default=20, help="Top-N organic URLs to collect per query/engine, not pagination pages. XMLRiver returns 10 URLs per SERP page, so depth 100 = 10 paid page requests per query/engine.")
    p.add_argument("--collect-live", action="store_true")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--paid-approved", action="store_true")
    p.add_argument("--env", default="")
    p.add_argument("--run-label", default="")
    p.add_argument("--timeout", type=int, default=60)
    p = sub.add_parser("run-topic", help="Run one-topic GEO/AEO workflow.")
    add_context_args(p)
    p.add_argument("--seed-queries", default="", help="Legacy alias for --cluster-queries; do not use as a separate query source.")
    p.add_argument("--serp-csv", default="")
    p.add_argument("--ai-csv", default="")
    p.add_argument("--collect-live-serp", action="store_true")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--paid-approved", action="store_true")
    p.add_argument("--include-ai", action="store_true")
    p.add_argument("--load-async-ai-overview", action="store_true")
    p.add_argument("--depth", type=int, default=20, help="Top-N organic URLs to collect per query/engine, not pagination pages. XMLRiver returns 10 URLs per SERP page, so depth 100 = 10 paid page requests per query/engine.")
    p.add_argument("--provider", default="xmlriver", choices=["xmlriver", "dataforseo"])


    p = sub.add_parser("generate-page-tz", help="Generate a page-level TZ from QFO and AI-cited competitor evidence.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", required=True)
    p.add_argument("--competitor-urls", default="")
    p.add_argument("--competitor-content-dir", default="")
    p.add_argument("--qfo-queries-file", default="", help="Explicit user/imported QFO rows; pending auto-discovered QFO files are never scanned.")
    p.add_argument("--approved-content-plan-file", default="", help="Approved QFO content-plan CSV/JSON for the selected page.")
    p.add_argument("--page-id", default="", help="Exact approved content-plan page_id for this TZ.")
    p.add_argument("--cluster-queries", default="", help="Semicolon/comma/newline separated user semantic cluster queries for this topic.")
    p.add_argument("--cluster-queries-file", default="", help="TXT or CSV file with semantic cluster queries.")
    p.add_argument("--max-competitors", type=int, default=5)
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--timeout", type=int, default=15)
    p.add_argument("--language", default="ru", help="Language code. XMLRiver Google sends lr=<code>; XMLRiver Yandex sends lang=<code>.")
    p = sub.add_parser("generate-tz", help="Create or refresh semantic SEO TZ handoff JSON.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")

    p = sub.add_parser("invoke-tz-generator", help="Invoke an approved semantic SEO TZ generator command template.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--generator-command", default="")
    p.add_argument("--invoke-approved", action="store_true")
    p.add_argument("--generator-contract-ref", default="")
    p.add_argument("--timeout", type=int, default=300)

    p = sub.add_parser("find-placements", help="Create product-fit placement ideas from cluster, SERP, AI, and QFO evidence.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="", help="Cluster name or topic.")
    p.add_argument("--cluster-name", default="", help="Alias for --topic when the user frames the input as a query cluster.")
    p.add_argument("--queries", default="", help="Semicolon/comma/newline separated cluster queries.")
    p.add_argument("--queries-file", default="", help="TXT or CSV file with cluster queries.")
    p.add_argument("--product", default="", help="Product or service description.")
    p.add_argument("--target-action", default="", help="Target action: buy, register, request consultation, compare provider, etc.")
    p.add_argument("--geo", default="", help="Target GEO/region for placement fit checks.")
    p.add_argument("--language", default="", help="Language code for placement fit checks.")
    p.add_argument("--serp-urls", default="", help="SERP-visible URLs, separated by semicolon/comma/newline.")
    p.add_argument("--ai-urls", default="", help="AI citation/source URLs, separated by semicolon/comma/newline.")
    p.add_argument("--qfo-queries", default="", help="QFO/fan-out queries, separated by semicolon/comma/newline.")
    p.add_argument("--qfo-queries-file", default="", help="TXT or CSV file with QFO/fan-out queries.")
    p.add_argument("--allowed-platforms", default="", help="Allowed or preferred platforms/domains.")
    p.add_argument("--max-ideas", type=int, default=30)

    p = sub.add_parser("enrich-urls", help="Fetch approved URLs and create enrichment/chunk signals.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--urls", default="")
    p.add_argument("--network-approved", action="store_true")
    p.add_argument("--max-urls", type=int, default=20)
    p.add_argument("--timeout", type=int, default=12)

    p = sub.add_parser("completion-audit", help="Write a requirement-level completion audit for the installed project.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")

    p = sub.add_parser("final-evidence-audit", help="Audit external evidence and descope decisions before a final 100%% claim boundary.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")

    p = sub.add_parser("final-evidence-readiness", help="Create approval packets for remaining final evidence items without live calls.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--max-queries", type=int, default=2)
    p.add_argument("--depth", type=int, default=20)
    p.add_argument("--max-urls", type=int, default=10)
    p.add_argument("--env", default="")

    p = sub.add_parser("independent-audit-pack", help="Prepare compact context packs for approved independent reviewers without spawning subagents.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")

    p = sub.add_parser("record-descope", help="Record an explicitly approved final-evidence descope decision.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--evidence-id", required=True)
    p.add_argument("--approved-by", required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--date", default="")
    p.add_argument("--scope", default="")

    p = sub.add_parser("monitor-plan", help="Create monitoring prompt/KPI plan.")
    p.add_argument("--project-dir", default=".")
    p.add_argument("--topic", default="")
    p.add_argument("--goal", default="both")

    return parser


def add_context_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--domain", default="")
    parser.add_argument("--brand", default="")
    parser.add_argument("--brand-variants", default="", help="Semicolon/comma/newline separated confirmed brand spellings, aliases, transliterations, domain spellings, and product aliases.")
    parser.add_argument("--topic", default="")
    parser.add_argument("--region", default="", help="Optional override; omitted values preserve saved project context.")
    parser.add_argument("--language", default="", help="Optional override; omitted values preserve saved project context.")
    parser.add_argument("--engines", default="", help="Optional override; omitted values preserve saved project context.")
    parser.add_argument("--goal", default="", choices=["url_citation", "brand_as_solution", "both"], help="Optional override; omitted values preserve saved project context.")
    parser.add_argument("--competitors", default="")
    parser.add_argument("--pages", default="")
    parser.add_argument("--products", default="")
    parser.add_argument("--documents", default="")
    parser.add_argument("--allow-site-discovery", action="store_true")
    parser.add_argument("--context-notes", default="")
    parser.add_argument("--cluster-queries", default="", help="Semicolon/comma/newline separated user semantic cluster queries for this topic.")
    parser.add_argument("--cluster-queries-file", default="", help="TXT or CSV file with semantic cluster queries.")


def main(argv: list[str] | None = None) -> int:
    configure_stdio_utf8()
    parser = build_parser()
    args = parser.parse_args(argv)
    project_dir = Path(getattr(args, "project_dir", ".")).resolve()

    if args.command == "install":
        result = install_runtime(project_dir, runtime=args.runtime, install_native_adapter=args.install_native_adapter)
    elif args.command == "setup":
        result = setup_environment(project_dir, scan_neighbors=args.scan_neighbors, runtime=args.runtime, apply_runtime_adaptation_flag=args.apply_runtime_adaptation, reviewed_runtime_plan_hash=args.reviewed_runtime_plan_hash)
    elif args.command == "init-project":
        result = init_project_context(
            project_dir,
            domain=args.domain,
            brand=args.brand,
            brand_variants=args.brand_variants,
            topic=args.topic,
            region=args.region,
            language=args.language,
            engines=args.engines,
            goal=args.goal,
            competitors=args.competitors,
            pages=args.pages,
            products_services=args.products,
            documents=args.documents,
            allow_site_discovery=args.allow_site_discovery,
            context_notes=args.context_notes,
            cluster_queries=args.cluster_queries,
            cluster_queries_file=args.cluster_queries_file,
        )
    elif args.command == "collect-context":
        result = collect_project_context(
            project_dir,
            domain=args.domain,
            brand=args.brand,
            brand_variants=args.brand_variants,
            topic=args.topic,
            region=args.region,
            language=args.language,
            engines=args.engines,
            goal=args.goal,
            competitors=args.competitors,
            pages=args.pages,
            products_services=args.products,
            documents=args.documents,
            allow_site_discovery=args.allow_site_discovery,
            context_notes=args.context_notes,
            cluster_queries=args.cluster_queries,
            cluster_queries_file=args.cluster_queries_file,
            network_approved=args.network_approved,
            site_html_dir=args.site_html_dir,
            max_pages=args.max_pages,
            timeout=args.timeout,
        )
    elif args.command == "confirm-brand-variants":
        result = confirm_brand_variants(project_dir, brand_variants=args.brand_variants, confirmation_ref=args.confirmation_ref, confirmed_by=args.confirmed_by)
    elif args.command == "audit-access":
        result = audit_accessibility(project_dir, domain=args.domain, network_approved=args.network_approved, timeout=args.timeout)
    elif args.command == "llm-access-audit":
        result = llm_accessibility_audit(project_dir, url=args.url, network_approved=args.network_approved, render=args.render, timeout=args.timeout)
    elif args.command == "record-audit-decision":
        result = record_audit_decision(project_dir, audit_id=args.audit_id, decision=args.decision, reason=args.reason, decided_by=args.decided_by, decision_ref=args.decision_ref, decided_at=args.decided_at)
    elif args.command == "provider-audit":
        result = provider_audit(project_dir, provider=args.provider, env_path=args.env)
    elif args.command == "collect-serp":
        result = collect_serp(
            project_dir,
            topic=args.topic,
            provider=args.provider,
            engines=args.engines,
            region=args.region,
            language=args.language,
            seed_queries=args.seed_queries,
            cluster_queries=args.cluster_queries,
            cluster_queries_file=args.cluster_queries_file,
            depth=args.depth,
            max_queries=args.max_queries,
            include_ai=args.include_ai,
            network_approved=args.network_approved,
            paid_approved=args.paid_approved,
            dry_run=args.dry_run,
            timeout=args.timeout,
            env_path=args.env,
            load_async_ai_overview=args.load_async_ai_overview,
            quick_cluster_mode=args.quick_cluster_mode,
        )
    elif args.command == "qfo-analyze":
        result = qfo_query_analysis(
            project_dir,
            topic=args.topic,
            queries=args.queries,
            queries_file=args.queries_file,
            engines=args.engines,
            region=args.region,
            language=args.language,
            depth=args.depth,
            network_approved=args.network_approved,
            paid_approved=args.paid_approved,
            dry_run=args.dry_run,
            approval_ref=args.approval_ref,
            reviewed_plan_hash=args.reviewed_plan_hash,
            timeout=args.timeout,
            env_path=args.env,
            chatgpt_qfo_file=args.chatgpt_qfo_file,
            selected_themes=args.selected_themes,
            approved_content_plan_file=args.approved_content_plan_file,
            content_plan_approval_ref=args.content_plan_approval_ref,
            reuse_existing_evidence=args.reuse_existing_evidence,
            evidence_manifest=args.evidence_manifest,
            quick_cluster_mode=args.quick_cluster_mode,
        )
    elif args.command == "citation-visibility":
        result = citation_visibility_audit(
            project_dir,
            topic=args.topic,
            domain=args.domain,
            brand=args.brand,
            brand_variants=args.brand_variants,
            products=args.products,
            queries=args.queries,
            queries_file=args.queries_file,
            serp_csv=args.serp_csv,
            ai_csv=args.ai_csv,
            engines=args.engines,
            regions=args.regions,
            language=args.language,
            provider=args.provider,
            depth=args.depth,
            collect_live=args.collect_live,
            network_approved=args.network_approved,
            paid_approved=args.paid_approved,
            env_path=args.env,
            run_label=args.run_label,
            timeout=args.timeout,
        )
    elif args.command == "run-topic":
        result = run_topic_workflow(
            project_dir,
            topic=args.topic,
            domain=args.domain,
            brand=args.brand,
            brand_variants=args.brand_variants,
            region=args.region,
            language=args.language,
            engines=args.engines,
            goal=args.goal,
            seed_queries=args.seed_queries,
            cluster_queries=args.cluster_queries,
            cluster_queries_file=args.cluster_queries_file,
            serp_csv=args.serp_csv,
            ai_csv=args.ai_csv,
            collect_live_serp=args.collect_live_serp,
            network_approved=args.network_approved,
            paid_approved=args.paid_approved,
            include_ai=args.include_ai,
            depth=args.depth,
            provider=args.provider,
            load_async_ai_overview=args.load_async_ai_overview,
        )
    elif args.command == "generate-page-tz":
        result = generate_page_tz(
            project_dir,
            topic=args.topic,
            competitor_urls=args.competitor_urls,
            competitor_content_dir=args.competitor_content_dir,
            qfo_queries_file=args.qfo_queries_file,
            approved_content_plan_file=args.approved_content_plan_file,
            page_id=args.page_id,
            cluster_queries=args.cluster_queries,
            cluster_queries_file=args.cluster_queries_file,
            max_competitors=args.max_competitors,
            network_approved=args.network_approved,
            timeout=args.timeout,
            language=args.language,
        )
    elif args.command == "generate-tz":
        result = generate_tz_handoff(project_dir, topic=args.topic)
    elif args.command == "invoke-tz-generator":
        result = invoke_tz_generator(project_dir, topic=args.topic, generator_command=args.generator_command, invoke_approved=args.invoke_approved, timeout=args.timeout, generator_contract_ref=args.generator_contract_ref)
    elif args.command == "find-placements":
        result = find_placements(
            project_dir,
            topic=args.topic,
            cluster_name=args.cluster_name,
            queries=args.queries,
            queries_file=args.queries_file,
            product=args.product,
            target_action=args.target_action,
            geo=args.geo,
            language=args.language,
            serp_urls=args.serp_urls,
            ai_urls=args.ai_urls,
            qfo_queries=args.qfo_queries,
            qfo_queries_file=args.qfo_queries_file,
            allowed_platforms=args.allowed_platforms,
            max_ideas=args.max_ideas,
        )
    elif args.command == "enrich-urls":
        result = enrich_urls(project_dir, topic=args.topic, urls=args.urls, network_approved=args.network_approved, max_urls=args.max_urls, timeout=args.timeout)
    elif args.command == "completion-audit":
        result = completion_audit(project_dir, topic=args.topic)
    elif args.command == "final-evidence-audit":
        result = final_evidence_audit(project_dir, topic=args.topic)
    elif args.command == "final-evidence-readiness":
        result = final_evidence_readiness(project_dir, topic=args.topic, max_queries=args.max_queries, depth=args.depth, max_urls=args.max_urls, env_path=args.env)
    elif args.command == "independent-audit-pack":
        result = independent_audit_pack(project_dir, topic=args.topic)
    elif args.command == "record-descope":
        result = record_final_evidence_descope(project_dir, evidence_id=args.evidence_id, approved_by=args.approved_by, reason=args.reason, date=args.date, scope=args.scope)
    elif args.command == "monitor-plan":
        result = monitor_plan(project_dir, topic=args.topic, goal=args.goal)
    else:
        parser.error(f"unknown command: {args.command}")
        return 2

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") in {"success", "skipped", "partial_success"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
