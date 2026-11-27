# QA
- v5 PDF: 25 pages, 36 links, source retained unchanged. Content inspected: five case studies, two-page cautionary example, checklist and photo assessment.
- Creative images: 1080×1350 each. Reel: H.264, 1080×1920, 20 s, no soundtrack. Portfolio photos composited without retouching.
- Browser preview: Chromium offline document render at 320, 390, 1440 px. No horizontal overflow; required fields and invalid email rejected; marketing unchecked by default; preview link appears after valid sample values; no POST and no JS errors. Local URL/file navigation was restricted by the environment, so inlined HTML/CSS/JS/assets were tested instead; not a deployed URL or an actual PDF download test.
- API boundary: Node 22 `node --test lead-magnet-intake.test.mjs`: 5 pass, 0 fail. Mock persistence only. No Supabase migration, real mail send, provider integration, Meta conversion, or production browser acceptance performed.

- v6: author note and introduction corrected; 25 pages and 36 links preserved. No production deployment.
