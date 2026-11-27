# QA
- v5 PDF: 25 pages, 36 links, source retained unchanged. Content inspected: five case studies, two-page cautionary example, checklist and photo assessment.
- Creative images: 1080×1350 each. Reel: H.264, 1080×1920, 20 s, no soundtrack. Portfolio photos composited without retouching.
- Browser preview: Chromium offline document render at 320, 390, 1440 px. No horizontal overflow; required fields and invalid email rejected; marketing unchecked by default; preview link appears after valid sample values; no POST and no JS errors. Local URL/file navigation was restricted by the environment, so inlined HTML/CSS/JS/assets were tested instead; not a deployed URL or an actual PDF download test.
- API boundary: Node 22 `node --test lead-magnet-intake.test.mjs`: 5 pass, 0 fail. Mock persistence only. No Supabase migration, real mail send, provider integration, Meta conversion, or production browser acceptance performed.

- v6: author note and introduction corrected; 25 pages and 36 links preserved. No production deployment.

## Staging validation (2026-11-27)
- Applied the isolated lead-magnet migration to CRM staging only. Production untouched. Two initial SQL syntax errors were corrected before successful application. Verified RLS enabled and anonymous/authenticated direct SELECT denied for all five private tables.
- Synthetic transactional database acceptance passed 10 scenarios: capture, duplicate, no opt-in, artist isolation, opt-in, D0-before-marketing, lease token, unsubscribe, suppression, expired-lease quarantine. Fixtures rolled back. No real email sent.
- Node 22 delivery adapter 10/10 and unsubscribe handler 4/4 passed with mock provider and database. These are not real Gmail/HTTP integration tests.
