# Vishar CRM: AI layer and delivery alerts, 2026-10-04

Evidence is read-only production data (Supabase `vishar-crm-production`) and
the code on `agent/platform-telegram-self-service` at `1d6c9c08`. Production
was release rc1013 (`25e68f9a`, migrations up to `20261004090000`).

## Architecture found

Enquiry text:
`booking form -> public.enquiries (form fields + idea) -> enquiry_ai_jobs
(Workers AI Llama 3.1 8B, structured extraction + summary) -> stored result,
shown nowhere in the CRM; used only for "intake_ai_conflicts" in the MCP
consultation context`.

Client brief:
`any CRM change -> crm_agent_jobs refresh_client_ai_state -> Worker
(crm-agent.js, Llama 3.1 8B, fallback Qwen 27B, contract v2, Russian output
when the artist reads Russian) -> client_ai_state.summary/brief -> CRM enquiry
page "AI-разбор", new-enquiry Telegram card (style, colour, cover-up context,
long idea replaced by the AI project summary), MCP plugin`.

Images:
`enquiry_files -> crm_agent_jobs analyze_reference_image -> Worker signs a
60-second storage URL, sends JPEG/PNG/WebP to Qwen 27B (fallback Gemma) ->
enquiry_file_ai_analysis -> input of the client brief only`. Not shown in the
CRM.

Deliveries:
`integration_outbox -> Workers (Gmail, WhatsApp, Calendar, Telegram) ->
record_*_outbox_result (8 attempts, exponential backoff) -> dead ->
service_sweep_operational_failure_alerts (daily, count only) ->
notifications -> Telegram`.

## Findings

| Feature | Observed | Decision |
| --- | --- | --- |
| Russian translation of client text (brief/summary) | 8 of the latest briefs: shin -> "side of the leg", whole arm -> "shoulder", jaguar -> "lambs", a colour-fading reason inverted and filed as a promise, size conflicts that were never written. | REMOVE. Brief stays in the source language. |
| AI summary on the enquiry page and in Telegram | Same model and errors; Telegram replaced long client ideas with the AI paraphrase. | REMOVE from both. Client words only, shown in full. |
| Intake extraction (`enquiry_ai_jobs`) | Duplicates the structured form; shown nowhere; 34/34 automatic drafts discarded (drafts already off since 09-30). | REMOVE (DB and Worker switches off). |
| Invented numbers in the brief | Prompt example "10 cm earlier, 15 cm newest" copied as fact in 4 of 8 briefs. | FIX: example removed; deterministic guard drops any brief text with a number absent from the source data. |
| Image analysis (Qwen 27B) | 55 of 74 images (30 days) analysed; descriptions match image content (reads captions, faded ink, a marker sketch on skin). No CRM surface claims analysis. | KEEP as internal input to the brief (MCP plugin). No UI added. |
| Assistant-written email drafts (MCP/GPT) | Used: approved within 7-11 s. Never delivered (see below). | KEEP; delivery fixed. |
| Next-action suggestions | Already not pushed since 09-30; not shown in CRM pages. | Unchanged. |
| AI failure Telegram alerts | 10 in 14 days about a feature the artist does not see. | REMOVE. |

## Delivery alert root cause

The 2026-10-04 08:45 alert was outbox job `12d9c38a` (`approved_email`, one
client, approved 08:15 London, 8 attempts until 09:40, `gmail_rpc_failed`).
`approve_email_draft` queued every approved email with `enquiry_id` and
`project_id` NULL. The Gmail resolver requires them to equal the email's own,
raised `22023 Gmail CRM target is unavailable`, and the Worker recorded
`gmail_rpc_failed`; with a Gmail thread attached the claim produced
`gmail_email_job_invalid` instead (10-01). Of the three enquiry emails ever
approved in production, two failed this way and one was cancelled before a
send; none reached the client. The alert
was count-only, deduplicated per UTC day over a rolling 24 hours, so a single
evening failure alerted twice (10-01 18:50 and 10-02 00:00).

Fixed in `20261004140000_crm_ai_rebuild_and_actionable_delivery_alerts.sql`:
the queue keeps enquiry and project; an unsendable record dies on the first
attempt; one alert per failed client-facing delivery with client, time,
attempts, reason, retry state, action and a link to the client; no alert for
deliveries sent or withdrawn before the sweep, Telegram's own jobs, contact
sync, ad conversions or AI jobs.

## Follow-up: manual translation, image analyses, vision cap

- **Translation: ON-DEMAND.** The enquiry page has a "Перевести на русский"
  button. Nothing runs on page load. The original text stays in full above the
  translation, which is labelled as a machine translation and cached per exact
  source text (`crm_private.enquiry_translations`, sha256); an edited message is
  never shown with an old translation. Task `enquiry_translation` never uses
  Llama 3.1 8B: Qwen 27B leads, the Workers AI tier pins its own model from a
  closed list. Every answer passes deterministic fidelity checks (numbers,
  left/right, inner/outer, upper/lower, body part, sleeve, cover-up, colour,
  black and grey, negation, uncertainty, questions, length) or is refused. A
  failure is shown on the button only and never notifies.
- **Image analyses.** Unchanged and not shown in the CRM. The plugin's
  consultation context now carries the stored vision-model descriptions as
  written (`reference_analyses`), when the caller may read the enquiry.
- **Vision 1.5 MB cap: already fixed on trunk.** Worker download, router,
  table constraint, upload RPC and bucket all use 4 MiB; production analysed
  images up to 3.54 MB. The seven failed analyses (2.0-2.8 MB, 2026-09-15..24)
  were provider timeouts, rate limits and schema misses, not a size refusal.
  `scripts/test-vision-upload-cap.mjs` pins the shared ceiling and pushes a
  3.9 MB image through download and routing.

### Translation model choice (live eval 2026-10-04, run 37210254188)

10 sanitized fixtures modelled on real enquiries, 2 repeats, each answer
scored by the Worker fidelity checks plus fixture patterns (wrong side, body
part, invented price):

| model | checks pass | p50 | main misses |
|---|---|---|---|
| Gemma 4 26B | 0.9 (1.0 after checker fix) | 1.7 s | none real ("lower back" -> "поясница" was a checker gap) |
| Qwen 3.8 27B | 0.7 | 9.1 s | calf lost, "upper arm" lost, "sessions" lost |
| Llama 3.3 70B | 0.7 | 1.7 s | sleeve, left/upper arm, negation, cover-up |
| gpt-oss-120b | 0.6 | 1.3 s | half sleeve, cover-up |
| Mistral Small 24B | 0.6 | 4.1 s | half sleeve, calf, cover-up |
| Llama 3.1 8B (old) | 0.5 | 0.4 s | sleeve, calf, cover-up, Saturday |

Chosen: Gemma 4 26B first, Qwen 27B fallback. Answers that fail the
fidelity checks are refused at runtime, whatever the model.
