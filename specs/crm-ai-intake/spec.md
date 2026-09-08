# Feature Specification: CRM AI intake MVP

## Status
Release candidate implementation. Target: Vishar-site CRM trunk. User authorizes implementation, release and safe production acceptance.

## Problem and goals
Artists currently copy enquiries into ChatGPT, manually extract details and separately draft replies. A supported booking or relevant Gmail inbound message should produce structured suggestions, missing information, a summary and an editable reply draft within the correct CRM enquiry.

## Requirements
- FR1: Reuse durable public/hosted booking intake and the existing authorised, enquiry-scoped Gmail read path. Preserve original intake when AI fails. No duplicate mailbox ingestion architecture.
- FR2: Extract name, email, phone, description, concept, placement, style, size, colour, cover-up, budget, availability, reference presence, discovery and notes with explicit/inferred/missing provenance. Never invent missing values. Validate strict shape, length and enum constraints before writes.
- FR3: Resolve ownership from trusted server state; match identities only inside the existing workspace. Models cannot select record IDs or call tools/SQL.
- FR4: Persist AI suggestions separately from saved human data. Do not overwrite human edits. Reject stale results and concurrent duplicate completions.
- FR5: Produce editable drafts only. No sending, booking, promised dates, payment changes or unsupported prices/session counts.
- FR6: Show summary, suggestions, missing information, processing/retry state and reply in the existing enquiry UI. Reuse email draft editing.
- FR7: Reuse provider-neutral router, prefer Cloudflare Qwen, fallback to Workers AI. No required OpenAI. Client content is untrusted data, including instructions embedded in emails.
- FR8: Durable scoped processing/audit metadata; no bodies, prompts, credentials or image content in infrastructure logs. Keep images disabled; text activation requires accurate published privacy wording.

## Failure, concurrency and retention
Durable unique processing job per supported source event; leased claims; bounded retries; atomic completion and draft creation. Original enquiry remains valid throughout. Results follow owning enquiry access/deletion boundaries. Generic audit stores identifiers and outcomes only.

## Acceptance
Verify normal/missing/invalid extraction, router outage, intake preservation, duplicate claims/completions, tenant denials, malicious instructions and model IDs, human-edit race, draft-only/no payment or booking side effects, safe logs. Verify exact-head CI, merge, deployed SHA/config readback and safe real supported enquiry acceptance without fake production customers.

## Non-goals and open decisions
No scheduling, automatic communication, payments, unrelated channel changes or AI dashboard. Image understanding remains disabled. Publish accurate text-processing disclosure before activation, without inventing legal bases or processor commitments. No historical bulk backfill or first-view Gmail backfill.
