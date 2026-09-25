# Decision layer: SQL facts → fast decisions → text generation

Status: design and shadow preparation. Nothing here is a production cutover.

## Why

Today one generative call (Llama, Qwen as fallback) returns the brief, the
stage, the waiting side, the next action and the draft together. Three
problems follow:

- Workflow facts that the database already knows get re-guessed by a model.
  Phase 2/3 move stage, waiting side, SLA and allowed actions to SQL.
- Small, frequent semantic judgements pay for a full generative call and
  inherit its latency and failure modes. Examples: "does this need a reply?"
  and "which allowed action is next?".
- The expensive text model runs even when no text is needed, for instance for
  a thank-you or a travel note.

## Responsibilities

| Layer | Owns | Never |
|---|---|---|
| Deterministic SQL (Phase 2/3) | stage, waiting side, SLA, response debt, conflicts, `allowed_actions`, booking/session/deposit/payment facts | guesses meaning of free text |
| Decision model (Jev candidate) | `reply_needed`, `next_action` chosen from `allowed_actions`, `commitment_risk`, `human_review_needed`; optionally priority | stage, booking, dates, deposit/payment state, price, bypassing SQL guards/ACL/RLS, sending anything |
| Llama 3.1 8B (Workers AI) | enquiry extraction, brief summary, open questions, promises, draft replies, free text | authoritative facts; draft on commitment actions (schema-enforced) |
| Qwen 3.8 27B | vision, while it is the only model with a valid structured answer; otherwise the text fallback | high-volume routine extraction (slower, ~10× Neurons, no measured quality gain) |
| GPT/Claude | not used; reserved for a proven complex-reasoning gap | routine work |

Target flow for one client-state refresh:

1. SQL computes the attention facts and `allowed_actions`, which are authoritative.
2. The decision model answers four typed questions over a minimal state (below).
3. If `reply_needed` is false and the chosen action is not draftable, no
   generative call is needed for the next action. The brief is refreshed on its
   own schedule.
4. Otherwise Llama writes the text (summary and/or draft) for the action the
   decision layer selected. Commitment actions carry no draft.

## Minimal payload

The decision model receives only:

- `stage`, `deposit_state`, `has_future_tattoo_session`,
  `has_future_consultation`, `last_speaker`, `hours_since_last_contact`
  (all from SQL);
- `allowed_actions` (from SQL);
- `latest_client_message`: the latest inbound text, truncated to about 1,000 characters;
- `previous_studio_message`: the latest outbound text, truncated.

It never receives names, contact details, addresses, prices, amounts, dates of
sessions, image content, notes or history beyond the two messages. The eval
self-test asserts this key set.

## Fail-closed contract

- **Transport.** On a timeout, HTTP error, malformed answer or unknown action,
  the decision is discarded and the existing path decides. The layer never
  retries more than the bounded retry.
- **Confidence.** A boolean is used only if |p − 0.5| ≥ 0.3. An action is
  used only if its confidence is ≥ 0.6. Anything below abstains, and
  abstention falls back to the existing path or to `artist_review`, never to
  a commitment action.
- **Allowed actions.** The choice set sent is exactly the server list. An
  answer outside it is discarded, whatever its confidence.
- **Staleness.** Each decision carries the attention watermark it was
  computed on. If the watermark moved before the decision is used, the
  decision is discarded.
- **Authority.** The decision layer's output is a recommendation row. It
  cannot write stage, bookings, sessions, payments or messages. Database
  triggers from Phase 3 (`client_ai_next_action_allowed`) still reject a
  disallowed action type.
- **Audit.** For each decision the audit keeps the model id as served, the
  prompt/contract version, the watermark, the four answers with their
  probabilities/confidence, whether it was used or abstained, and the
  latency and cost. It keeps no message text.

## Privacy gate before real client data

Real client messages must not reach OpenRouter/TypeSafe until:

1. The data-processing terms of OpenRouter and the served provider (TypeSafe)
   are reviewed: retention, training use, sub-processors and region. Where
   available, zero-retention / no-training routing is required.
2. The minimal payload above is confirmed as enough by shadow evidence on
   synthetic data.
3. The product owner accepts the processor, as for any new processor of
   client messages. This is a legal/product decision, not an engineering one.

Until then, shadow mode can run on synthetic and eval fixtures only.
Production shadow on real traffic is blocked by this gate.

## Rollout gates

1. Offline eval v2 (dev + independent holdout + baseline, repeats). The bar is:
   - holdout answered accuracy ≥ 0.9 per question;
   - commitment/human-review recall on holdout ≥ 0.95;
   - no allowed-action violations;
   - identical-decision rate across repeats ≥ 0.9.
2. Privacy gate (above).
3. Production shadow: decisions go to telemetry only and are compared with the
   current path and the operator's actual handling. No user-visible effect.
4. Only then a flagged cutover per question, starting with `reply_needed`.
   Each question can be reverted independently.

## Evidence (synthetic only)

Runs: 36172142494 (78 cases × 2) and 36173240531 (98 cases × 2).
Model: `typesafe/jev-1.13`, served as `typesafe/jev-1.13-20260917` by
TypeSafe. All 98 cases offer several allowed actions.

The table is from run 36173240531. "Answered acc." is accuracy on cases
where the model was confident enough to answer.

| Split | reply_needed answered acc. / abstain | commitment_risk | next_action | human_review_needed |
|---|---|---|---|---|
| dev (24) | 1.00 / 11% | 1.00 / 9% | 0.89 / 27% | 0.91 / 52% |
| holdout (44) | 0.97 / 17% | 0.97 / 19% | 0.93 / 31% | 0.76 / 44% |
| holdout2 (20) | 1.00 / 16% | 1.00 / 21% | 0.88 / 18% | 1.00 / 61% |
| baseline (10) | 1.00 / 11% | 1.00 / 39% | 1.00 / 50% | 1.00 / 63% |

Other results:
- 196 calls, 0 API errors, cost $0.0076 (about $0.00004 a decision).
- p50 about 130 ms, p95 about 200 ms.
- The same decision on repeat for 94% of cases; the action flipped in 4%.
- The answer was always inside `allowed_actions`.

Findings:

- `commitment_risk` was never confidently false on a commitment case
  (0 of 60+).
- `human_review_needed` on its own is unreliable. It was confidently false on
  weekend availability, hourly rate, "either date is fine", a client who
  believes a session is booked when it is not, and a deposit link after
  payment.
- The fail-closed review rule routes to the artist unless both questions are
  confidently false. It was chosen after run 1 and tested on holdout2, which
  was written after run 1. Review recall is 1.00 on every split. The cost is
  that about half of the safe cases also go to review.
- Next-action errors on answered cases:
  - `request_information` for a price question;
  - `no_action` for simple logistics questions (address, parking);
  - `offer_dates` for "ok sounds good" while dates were already being checked.

  None of these is outside the allowed list, and all are recommendations the
  artist sees.
- Baseline: on the client-state cases Llama/Qwen are scored on, Jev's raw
  action passed every action check, as Llama's did in the live eval
  (36154979615/36171131094). Llama takes about 2 s and about 15–30 Neurons;
  Qwen takes about 38 s and about 200 Neurons; Jev takes about 0.13 s and
  about $0.00004.

What this supports:
- `reply_needed` and `commitment_risk` are candidates for shadow mode.
- `next_action` in shadow only, compared with the current path.
- `human_review_needed` is used only inside the review rule.

What it does not support:
- any cutover;
- any real-data use before the privacy gate.
