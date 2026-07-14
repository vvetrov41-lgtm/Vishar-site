# ADAPTATION_REPORT

Generated: 2026-07-14T18:28:44+00:00

## Environment

- OS: Linux-6.18.5-x86_64-with-glibc2.39
- Python: 3.11.15
- Working directory: .
- Project root: .
- Agent runtime: geo-topic-agent 1.4.0

## Runtime / IDE

- active runtime: claude
- detection confidence: explicit
- detection source: setup_argument
- runtime profile: geo_agent/runtime/runtime-profile.json
- birth plan: geo_agent/runtime/birth-plan.json
- inactive adapter actions applied: 0

## Found Configs

- env files: /home/user/Vishar-site/.env.example
- masked env keys: {}
- project marker files: .env.example, package.json

## XMLRiver

- found client: no
- paths: none
- test request: not run; live provider calls require explicit approval

## AI Answers

- found module: yes
- paths: 
  - /home/user/Vishar-site/geo_agent/data/import/ai_answers_template.csv
- manual import template: geo_agent/data/import/ai_answers_template.csv

## Semantic SEO TZ Generator

- found: no
- paths: none
- input format: data/handoff/semantic_tz_handoff_<topic>.json

## Created By Agent

- config: /home/user/Vishar-site/geo_agent/config/geo_agent_config.json
- reports: /home/user/Vishar-site/geo_agent/reports
- data: /home/user/Vishar-site/geo_agent/data
- import templates: /home/user/Vishar-site/geo_agent/data/import
- final evidence templates: /home/user/Vishar-site/geo_agent/data/import/final_evidence
- handoff dir: /home/user/Vishar-site/geo_agent/data/handoff

## First-Run Intake

Ask the user one question at a time. Start with site/domain. After the site/domain is known and setup is complete, the next step is the Deep Context Offer Gate: offer to collect product/business context independently from the homepage, user-provided landing pages, header/navigation, footer, pricing/payment/subscription/trial/demo/free-access/delivery/contact/about/legal/case/review/FAQ pages. Ask explicit approval for public site discovery/network, or ask for documents/local HTML snapshots. Do not jump directly to topic/SERP/QFO/TZ work before deep context is collected or explicitly declined.

## User Action Needed

- Add XMLRiver credentials or point the agent to an existing XMLRiver client.
- Provide path to semantic_brief_builder.py or another TZ generator if automatic handoff invocation is needed.
