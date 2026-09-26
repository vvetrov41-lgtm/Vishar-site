# Tasks

Status as of 2026-09-26. Evidence is content-free: counts, bounded codes and
timings from `crm_private.ai_runs`, `crm_private.attention_shadow_runs` and the
guarded live eval. No client text is recorded here.

- [x] Audit and review corrections (PR #869)
- [x] Phase 0: AI run telemetry (PR #870, migration 20260924010000)
  - First real production job 2026-09-24 08:05 UTC: Qwen `provider_timeout`
    at 30 000 ms, Llama fallback succeeded in 3 436 ms, per-attempt tokens and
    finish reason recorded.
- [ ] Phase 1: model reliability and evaluation (PRs #871, #873, #876, #880–#884, #886, #888, #906)
  - Open until a natural intake succeeds after the #906 Worker release.
  - Natural production traffic, 2026-09-26 14:51–15:31 UTC:
    - vision: 3/3 `reference-image.2026-09-10` runs succeeded on Workers AI
      (2 attempts each, 20–34 s);
    - intake: 1 `enquiry-intake.2026-09-10` run succeeded in 3.0 s;
    - 2 intake runs failed with `all_providers_failed` /
      `fields.colour.enum` after 2 attempts (30–36 s): a colour word outside
      the three CRM tokens failed the whole extraction. Fixed by a
      deterministic colour synonym map; an unknown enum word now makes only
      that field `missing`.
  - 4006 (2026-09-24 ~19:15 UTC onward): a Workers AI platform code taken
    from the binding exception, kept separate from our class
    (`provider_rate_limited`). It is not in the public error table, which
    lists 3036/429 for an exhausted daily allocation. Correlated with heavy
    Qwen spend; inference was available again on 2026-09-25 by 12:53 UTC.
  - Controlled eval 36154979615 (49 calls):
    - Llama intake: valid 4/4, checks 4/4, 3.3 s, ~18 Neurons.
    - Llama client state: valid 6/6, checks 5/6, 2.0 s, ~15–30 Neurons.
    - Qwen: slower (16–38 s) and ~10× the Neurons, with no measured quality
      gain.
    - Gemma/GLM returned empty answers: thinking used up the budget.
  - Routing (#884):
    - Llama leads intake and client state; Qwen is the fallback, and its
      intake schema is transport.
    - Vision stays Qwen → Gemma, with thinking off for Gemma.
  - Acceptance:
    - Routing probes 36170812741 (found a probe validator defect, fixed in
      #886) and 36173777831 (all green).
    - Eval 36174026219: the production vision chain was valid twice, once from
      Qwen in 7.5 s and once from the Gemma fallback after a Qwen timeout. The
      Gemma container repair is in #886.
  - Production after the convergence sweep (#889, 8 per hour): Llama
    client-state refreshes at 2.3 s and ~20 Neurons each, 8/8 succeeded.
  - Forecast: a typical day (≈20 client-state refreshes, ≈3 intakes, ≈3
    images) is ≈1.2k Neurons; the busiest observed day at Llama prices is
    ≈2.5k. 10k/day is enough without Workers Paid unless vision volume grows
    a lot.
- [ ] Phase 2: deterministic attention engine in shadow mode (PRs #872, #874)
  - 18 hourly shadow runs over 32 clients: waiting_on disagreed for 26,
    stage for 23, AI actions disallowed by the rules 0.
  - Two rule errors found and fixed (#874): an operator clearing a reply item
    is `handled` (the studio's turn), and an engaged `new` enquiry is
    `gathering_information`; Gmail acknowledgements were never matched.
    waiting_on disagreement fell to 14/32 after release.
  - Remaining stage disagreement is mostly against stale AI briefs (Phase 6a).
- [ ] Phase 3: narrow client-state contract (#890, #895, #897–#900, #902)
  - v2 active since 2026-09-26 08:06 UTC. The criterion is 7 days with no
    next action superseded by an insert guard; the soak ends 2026-10-03
    08:06 UTC. First day, to 15:31 UTC:
    - 6/6 `client-state.2026-09-26c` runs succeeded on Workers AI, 1 attempt,
      no fallback, 2.9–5.3 s;
    - refreshed briefs: stage and waiting_on differ from `client_attention`
      in 0 of 3;
    - 6 proposed actions (`artist_review`, `request_information`), all
      within `allowed_actions`; `service_contract_rule_summary(24)` reports 0
      rule-disallowed;
    - `confirm_booking` is a deterministic invariant (#902, migration
      20260924080000): 0 open, `confirm_booking_ready` false for every client.
- [ ] Phase 4: unified Today / Pulse (#891, stacked on #890; behind
      `crm_agent_config.today_pulse` and `CRM_TODAY_PULSE_ENABLED`)
- [ ] Phase 5: unmatched communication triage (#892, stacked on #891)
  - Baseline: 28 open unknown-sender conversations waiting, 20 older than
    24 h; 1 exact unique phone match. WhatsApp exact matches already auto-link;
    Phase 5 adds a deterministic suggestion (Instagram handle, late phone).
- [ ] Phase 6: fact provenance and intake/client-state convergence
  - 6a (PR #875): 25/32 briefs stale with no job queued because the watermark
    hashed the whole clients row and 20260923020000 added columns. Narrow
    watermark and a bounded hourly convergence sweep.
- [ ] Decision layer (#887, `specs/crm-ai-architecture/decision-layer.md`)
  - Synthetic benchmark v2 (98 cases, two holdouts, repeats):
    - `reply_needed` and `commitment_risk` answered accuracy 0.97–1.00;
    - `next_action` 0.88–0.93, always within `allowed_actions`;
    - fail-closed review recall 1.00;
    - ~150 ms and ~$0.00004 per decision;
    - effective-decision stability 0.84 (gate 0.9).
  - The shared contract and transport are merged but not wired.
  - Blocked on the privacy gate (processor terms, zero retention, product
    owner decision) before any real client text is sent; production shadow
    comes next.
