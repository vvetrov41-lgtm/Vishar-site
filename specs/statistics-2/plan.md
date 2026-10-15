# Plan

## Architecture

```
crm_private.statistics_core(p_artist_id uuid, p_from timestamptz, p_to timestamptz, p_now timestamptz, p_finance boolean) returns jsonb
  stable, security definer, search_path pg_catalog, public, crm_private
  reads the statistics_* projections' row logic plus crm_private reply evidence
  returns: enquiries, bookings_made, conversion{cohort,mature,converted,pending,pending_converted},
           funnel, channels[], sessions{tattoo..., consultations...}, upcoming_weeks[], reply{median_hours,timed,attested,unanswered},
           finance{received[],refunded[],open[],forecast{priced,unpriced,booked_value[],remaining[]}} (only when p_finance)

public.get_statistics(p_artist_ids uuid[], p_from timestamptz, p_to timestamptz) returns jsonb
  security definer; for each requested artist: require has_artist_capability(view); finance flag = has_artist_capability(view_finance);
  window ≤ 400 days; previous window computed server side; history_start per artist;
  returns {artists: [{artist_id, current, previous, comparable, history_start}]}

public.gpt_get_statistics(p_from, p_to)  -> rewritten as a thin wrapper over statistics_core for the GPT context artist (keeps its JSON keys, adds the corrected ones; parity script updated)
crm_private.pulse_summary                -> unchanged; statistics_core calls the same enquiry_reply_state, so reply figures share one definition
```

Channel classification moves to SQL as `crm_private.enquiry_channel(utm_source, utm_medium, referrer, source, communication_channel)` (immutable), mirroring the PR #1095 TypeScript rules; the TS function stays only as a formatter of keys returned by the server.

## Stages (independent PRs)

1. **S2-1 Core RPC** — migration with `enquiry_channel`, `statistics_core`, `get_statistics`; pgTAP for definitions and denials; no UI change. Risk: SECURITY DEFINER surface → security checklist in `docs/ai/security-boundaries.md`.
2. **S2-2 Parity** — `gpt_get_statistics` as wrapper; `scripts/test-gpt-operator-parity.mjs` row `statistics.summary` points at the RPC; read-only production comparison script (aggregates only).
3. **S2-3 Screen on RPC** — `statistics-api.ts` calls `get_statistics`; `statistics.ts` reduced to formatting and labels; delete browser paging. Feature-flag fallback is not needed: the RPC ships first (stage 1) and is verified in production before this lands.
4. **S2-4 Mobile layout** — needs-attention block, 2×2 headline, weekly diary chart, funnel with answered step, channels with deposits paid, money actual vs forecast; Playwright 390×844 test.
5. **S2-5 Navigation** — Statistics reachable in one tap on iPhone (product decision: replace a tab-bar item or add a Today shortcut).

## Risks

| Risk | Mitigation |
|---|---|
| Definer RPC widens access | per-artist capability check before any read; pgTAP denial tests; no contact columns |
| Reply evidence is per-enquiry lateral (cost) | measure with `explain analyze` on production-size window; if > 300 ms, persist first_reply_at in crm_private via trigger in a later stage |
| GPT JSON consumers break | keep existing keys, add new ones; parity test |
| Meaning change of old numbers | already done in #1095; changelog line on screen |
| Auto-completion semantics (`completed` = time passed) | stated in definitions; consultation outcome capture is a separate product decision |

## Product decisions needed (not blocking S2-1..S2-3)

1. Tab-bar slot for Statistics on iPhone (S2-5).
2. Whether consultations should get an explicit outcome (held / no-show) so "consultation held" stops meaning "not cancelled and in the past".
3. Price coverage: should the session form require a price for tattoo sessions, so the forecast can be shown?
