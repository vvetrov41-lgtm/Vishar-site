# ACCESSIBILITY_AUDIT

Generated: 2026-07-14T18:29:12+00:00
Domain: https://vishartattoo.com/
Network approved: True

## Audit Checklist

| Check | Status | Evidence |
| --- | --- | --- |
| Network approval | [OK] | network approval granted |
| robots.txt fetch | [OK] | HTTP 200, 365 bytes |
| sitemap.xml fetch | [OK] | HTTP 200, 1825 bytes |
| Bot HTTP probes with full User-Agent strings | [OK] | all configured bot probes returned successful HTTP responses |
| WAF/security markers | [WARN] | WAF/security markers found in 10 probe responses |
| Main content volume | [OK] | main text volume did not trigger low-content warnings |

## Critical Issues

- none

## Warnings

- Googlebot: HTTP 200, 81253 bytes
- bingbot: HTTP 200, 81253 bytes
- YandexBot: HTTP 200, 81253 bytes
- OAI-SearchBot: HTTP 200, 81253 bytes
- ChatGPT-User: HTTP 200, 81253 bytes
- GPTBot: HTTP 200, 81253 bytes
- ClaudeBot: HTTP 200, 81253 bytes
- Claude-SearchBot: HTTP 200, 81253 bytes
- PerplexityBot: HTTP 200, 81253 bytes
- Perplexity-User: HTTP 200, 81253 bytes

## Robots

- status: success
- summary: HTTP 200, 365 bytes

## Sitemap

- status: success
- summary: HTTP 200, 1825 bytes

## User-Agent Matrix

HTTP probes use the full `http_user_agent` string. The `robots_token` column is only the robots.txt token and must not be used as the HTTP User-Agent for manual curl/PowerShell rechecks.

| Provider | Role | Robots token | HTTP User-Agent | Status | HTTP | Summary | WAF Signals |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Google | Google Search crawl/render | `Googlebot` | `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Microsoft | Bing/Copilot search crawl | `bingbot` | `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Yandex | Yandex main indexing | `YandexBot` | `Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| OpenAI | AI search indexing | `OAI-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| OpenAI | ChatGPT user-triggered fetch | `ChatGPT-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| OpenAI | model-training crawler | `GPTBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Anthropic | Claude crawler | `ClaudeBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Anthropic | Claude search fetch | `Claude-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Perplexity | AI answer crawler | `PerplexityBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |
| Perplexity | Perplexity user-triggered fetch | `Perplexity-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | success | 200 | HTTP 200, 81253 bytes | cloudflare, cf-ray |

## Manual Recheck Rule

- For manual rechecks, copy the full `HTTP User-Agent` value from the matrix.
- Do not run `curl -A "GPTBot"`, `curl -A "ClaudeBot"`, or other short-token probes for server-access conclusions; those are robots tokens, not complete crawler request headers.
