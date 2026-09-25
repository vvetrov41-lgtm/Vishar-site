# Tasks

Status as of 2026-09-25. Evidence is content-free: counts, bounded codes and
timings from `crm_private.ai_runs`, `crm_private.attention_shadow_runs` and the
guarded live eval. No client text is recorded here.

- [x] Audit and review corrections (PR #869)
- [x] Phase 0: AI run telemetry (PR #870, migration 20260924010000)
  - First real production job 2026-09-24 08:05 UTC: Qwen `provider_timeout`
    at 30 000 ms, Llama fallback succeeded in 3 436 ms, per-attempt tokens and
    finish reason recorded.
- [ ] Phase 1: model reliability and evaluation (PRs #871, #873, #876)
  - Live eval 1 (a3b4669): intake Qwen with the full JSON schema is refused
    instantly (8/8); transport/object schema 50–63 % valid with p50 19–28 s;
    Llama intake 50 % valid, failing only `fields.cover_up`; client-state
    Qwen with a 60 s budget 61 % valid, checks 94 %, p50 23 s, p95 44 s.
    Two variants measured the Worker's own 20/min write limiter (fixed in
    #873: pacing).
  - Production: every intake run failed (Qwen schema refusal, then Llama
    `cover_up`); #873 repairs boolean word drift and names the kind of break.
  - Since 2026-09-24 ~19:15 UTC every Workers AI binding call (Qwen, Llama,
    Gemma) fails in 17–40 ms; eval 2 (efb70e4): 108/108. Not a model or schema
    cause. #876 adds a bounded diagnostic token to name it.
  - Routing decision: pending until the binding failure is named. No routing
    change has been made on assumptions.
- [ ] Phase 2: deterministic attention engine in shadow mode (PRs #872, #874)
  - 18 hourly shadow runs over 32 clients: waiting_on disagreed for 26,
    stage for 23, AI actions disallowed by the rules 0.
  - Two rule errors found and fixed (#874): an operator clearing a reply item
    is `handled` (the studio's turn), and an engaged `new` enquiry is
    `gathering_information`; Gmail acknowledgements were never matched.
    waiting_on disagreement fell to 14/32 after release.
  - Remaining stage disagreement is mostly against stale AI briefs (Phase 6a).
- [ ] Phase 3: narrow client-state contract (branch `claude/crm-ai-phase3-contract`,
      behind flags, not merged: waits for Phase 1 routing evidence)
- [ ] Phase 4: unified Today / Pulse (branch `claude/crm-ai-phase4-pulse`,
      behind `crm_agent_config.today_pulse` and `CRM_TODAY_PULSE_ENABLED`)
- [ ] Phase 5: unmatched communication triage (branch `claude/crm-ai-phase5-triage`)
  - Baseline: 28 open unknown-sender conversations waiting, 20 older than
    24 h; 1 exact unique phone match. WhatsApp exact matches already auto-link;
    Phase 5 adds a deterministic suggestion (Instagram handle, late phone).
- [ ] Phase 6: fact provenance and intake/client-state convergence
  - 6a (PR #875): 25/32 briefs stale with no job queued because the watermark
    hashed the whole clients row and 20260923020000 added columns. Narrow
    watermark and a bounded hourly convergence sweep.
