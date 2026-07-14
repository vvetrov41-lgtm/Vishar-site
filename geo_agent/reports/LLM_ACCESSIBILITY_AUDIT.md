# LLM_ACCESSIBILITY_AUDIT

Generated: 2026-07-14T19:34:15+00:00
URL: https://vishartattoo.com
Network approved: True
Render requested: True

## Audit Checklist

| Layer | Status | Evidence |
| --- | --- | --- |
| Robots permission | [OK] | robots tokens evaluated |
| Ordinary server baseline | [WARN] | security/captcha code is present, but the main page content is still accessible |
| LLM/search bot HTTP probes with full User-Agent strings | [OK] | bot probes used full HTTP User-Agent strings and returned accessible responses |
| Rendered screenshot/text | [WARN] | Error: Page.goto: net::ERR_CONNECTION_RESET at https://vishartattoo.com/ Call log:   - navigating to "https://vishartattoo.com/", waiting until "networkidle"  |
| Clean LLM-style content | [OK] | clean LLM-style content extracted |
| Rendered vs clean-content parity | [SKIP] | rendered text is unavailable; screenshot comparison needs Playwright |
| Commercial content correctness | [OK] | no commercial extraction warnings |

## Critical Issues

- none

## Warnings

- none

## Robots Permission Summary

- allowed tokens: *, OAI-SearchBot, ChatGPT-User, GPTBot, Googlebot, Google-Extended, PerplexityBot, Perplexity-User, ClaudeBot, Claude-SearchBot, bingbot, BingPreview, YandexBot, YandexAccessibilityBot
- blocked tokens: none
- unknown tokens: none

| Provider | Role | Robots token | HTTP User-Agent probe | Robots status | Allowed | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Generic | ordinary browser baseline | `*` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36` | allowed | True | matched robots.txt rules |
| OpenAI | AI search indexing | `OAI-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot` | allowed | True | matched robots.txt rules |
| OpenAI | ChatGPT user-triggered fetch | `ChatGPT-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | allowed | True | matched robots.txt rules |
| OpenAI | model-training crawler | `GPTBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot` | allowed | True | matched robots.txt rules |
| Google | Google Search crawl/render | `Googlebot` | `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` | allowed | True | matched robots.txt rules |
| Google | Gemini/AI product control token | `Google-Extended` | `` | allowed | True | matched robots.txt rules |
| Perplexity | AI answer crawler | `PerplexityBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | allowed | True | matched robots.txt rules |
| Perplexity | Perplexity user-triggered fetch | `Perplexity-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | allowed | True | matched robots.txt rules |
| Anthropic | Claude crawler | `ClaudeBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot` | allowed | True | matched robots.txt rules |
| Anthropic | Claude search fetch | `Claude-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot` | allowed | True | matched robots.txt rules |
| Microsoft | Bing/Copilot search crawl | `bingbot` | `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)` | allowed | True | matched robots.txt rules |
| Microsoft | Bing preview fetch | `BingPreview` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 BingPreview/1.0b` | allowed | True | matched robots.txt rules |
| Yandex | Yandex main indexing | `YandexBot` | `Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)` | allowed | True | matched robots.txt rules |
| Yandex | Yandex availability/accessibility check | `YandexAccessibilityBot` | `Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0; +http://yandex.com/bots)` | allowed | True | matched robots.txt rules |

## Server Baseline

- status: success
- HTTP: 200
- summary: HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible
- text chars: 45660
- main content risk: unknown
- WAF signals: cloudflare, cf-ray
- access barrier class: security_code_present_content_accessible
- access barrier summary: security/captcha code is present, but the main page content is still accessible
- page block markers: cloudflare_challenge
- form captcha markers: none
- captcha outside forms: none
- main text chars without forms: 3624
- main block count without forms: 32

## LLM User-Agent HTTP Matrix

HTTP probes must use the full `HTTP User-Agent` string below. The `Robots token` is only for robots.txt matching and must not be used as the HTTP request header by itself.

| Provider | Role | Robots token | HTTP User-Agent | HTTP status | Status | Text chars | Delta | Barrier | WAF signals | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | AI search indexing | `OAI-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| OpenAI | ChatGPT user-triggered fetch | `ChatGPT-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| OpenAI | model-training crawler | `GPTBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Google | Google Search crawl/render | `Googlebot` | `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Perplexity | AI answer crawler | `PerplexityBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Perplexity | Perplexity user-triggered fetch | `Perplexity-User` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Anthropic | Claude crawler | `ClaudeBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Anthropic | Claude search fetch | `Claude-SearchBot` | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Microsoft | Bing/Copilot search crawl | `bingbot` | `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Microsoft | Bing preview fetch | `BingPreview` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 BingPreview/1.0b` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Yandex | Yandex main indexing | `YandexBot` | `Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |
| Yandex | Yandex availability/accessibility check | `YandexAccessibilityBot` | `Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0; +http://yandex.com/bots)` | 200 | success | 45660 | 0 | security_code_present_content_accessible | cloudflare, cf-ray | HTTP 200, 81253 bytes, text_chars=45660, barrier=security_code_present_content_accessible |

## Render And Clean Content

- clean extraction status: success
- clean text chars: 3799
- clean text ref: geo_agent/data/raw/llm-accessibility/vishartattoo-com-cd75802a3d63/llm_clean_content.txt
- render status: error
- screenshot: 
- rendered text ref: 

## Block Parity

- status: skipped
- summary: rendered text is unavailable; screenshot comparison needs Playwright
- rendered blocks: 
- clean blocks: 

### Missing Rendered Blocks In Clean Extraction

- none

### Extra Clean Blocks Not Found In Rendered Text

- none

## Commercial Correctness

- status: pass
- no commercial extraction warnings

### Extracted Commercial Signals

- clean prices: £140
- rendered prices: none
- struck/old-price markers in HTML: False
- struck/old-price text: none
- CTA terms: book

## Manual Recheck Rule

- For manual curl/PowerShell rechecks, copy the full `HTTP User-Agent` value from the matrix.
- Do not use short tokens such as `GPTBot`, `ClaudeBot`, or `OAI-SearchBot` as the whole HTTP User-Agent; those are robots tokens and can create false block conclusions.

## Next Actions

- If robots blocks an intended AI/search agent, update robots.txt intentionally and rerun.
- If baseline browser access is `page_block`, inspect WAF/CDN/security-plugin rules before testing LLM user agents.
- If baseline shows `form_protection_only`, do not report the page as closed to LLMs; keep page/content availability separate from form-submission protection.
- If LLM user agents get weaker content than baseline, whitelist verified bots by user-agent and IP source where the provider publishes IP ranges.
- If commercial parity warns, fix markup so current price, old price, discount, service name, availability, and CTA survive clean extraction.
- Register in zrok.cloud to collect more real AI-bot availability and visit data over time. It has a free tier, so the user can start collecting additional AI-bot evidence without payment.
