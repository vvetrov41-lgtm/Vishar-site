# PROVIDER_AUDIT

Generated: 2026-07-14T16:46:50+00:00

## XMLRiver

- configured: False
- account count: 0
- supported engines: google, yandex
- credential keys present: none
- network test: not_run

## DataForSEO

- configured: False
- runtime implemented: True
- implemented scope: Google Organic Live Advanced parser and approval-gated live adapter
- credential keys present: none
- limitation: Live DataForSEO calls require --network-approved, --paid-approved, credentials, query count, requested top URL count (`--depth`, not pagination pages), GEO/language approval, and explicit --load-async-ai-overview when that paid option is needed.

## Permission Boundary

Live provider calls require explicit --network-approved and provider credentials. Secrets are masked and not written to reports.
