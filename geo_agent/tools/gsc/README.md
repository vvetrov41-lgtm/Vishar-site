# Google Search Console integration

This project-local toolkit gives the GEO workflow read-only access to Search
Console data for `vishartattoo.com`. It does not change the website, submit URLs,
submit sitemaps, or use the Google Indexing API.

## Safety model

- The property guard accepts only `vishartattoo.com` properties.
- Authentication uses `webmasters.readonly` only.
- The Service Account key stays outside this public repository.
- Generated GSC exports stay under ignored `geo_agent/data/gsc/`.
- Commands never print a private key or a complete Service Account email.
- `doctor` is offline unless `--live` is supplied.

## One-time local installation

```bash
python scripts/setup_gsc.py
```

This creates ignored `.venv-gsc/`; it does not use `sudo` or modify the system
Python installation.

Default configuration:

```text
GSC_PROPERTY=sc-domain:vishartattoo.com
GSC_SERVICE_ACCOUNT_PATH=~/.config/vishar-site/gsc-service-account.json
```

`GSC_PROPERTY` is already defaulted in code. The key path can be overridden with
`GSC_SERVICE_ACCOUNT_PATH` or `GOOGLE_APPLICATION_CREDENTIALS`.

## Commands

```bash
# Offline setup check
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli doctor

# Confirm that Google grants access to the exact property
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli doctor --live

# Standard diagnosis for the site's low organic visibility
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli snapshot --inspect-sitemap

# Custom export
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli analytics \
  --dimensions query,page \
  --start-date 2026-04-01 \
  --end-date 2026-07-14

# Compare equal periods
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli compare \
  --period1 2026-05-18:2026-06-14 \
  --period2 2026-06-15:2026-07-12 \
  --dimensions query,page

# Find query rows that appear only in the newer period
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli new-queries \
  --period1 2026-05-18:2026-06-14 \
  --period2 2026-06-15:2026-07-12 \
  --min-impressions 5

# Inspect every URL in the tracked sitemap (cached index data, not a live test)
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli inspect --sitemap sitemap.xml
```

The snapshot collects daily 480-day history, 90-day page/query data, 90-day
query-to-page rows, a 480-day priority commercial-query slice, and a compact Markdown
summary. With
`--inspect-sitemap`, it also spends one URL Inspection request per sitemap URL.

## Required Google-side setup

1. Create or select a Google Cloud project.
2. Enable **Google Search Console API**.
3. Create a Service Account and download its JSON key.
4. Save the key outside the repository at the path above and set permission 600.
5. In Search Console, add the Service Account email to
   `sc-domain:vishartattoo.com` with the lowest permission that allows the
   required reports. If URL Inspection rejects restricted access, grant Full
   access; do not grant Owner unless Google explicitly requires it.
6. Run `doctor --live` before the snapshot.

Never paste the JSON key into an agent prompt, issue, commit, pull request, or
chat message.
