/**
 * Gemini API proxy with rate limiting.
 *
 * Rate-limit options (pick ONE):
 *
 * A) KV-based (this file) — requires a KV namespace bound as RATE_LIMIT.
 *    Set up in Cloudflare Pages → Settings → Bindings → Add KV Namespace.
 *
 * B) Cloudflare Rate Limiting Rules (dashboard) — zero code, more robust.
 *    Dashboard → Security → WAF → Rate limiting rules → Create rule
 *    URI path equals "/api/gemini", 10 requests per minute per IP → Block.
 */

const RATE_LIMIT_MAX = 10; // requests per window
const RATE_LIMIT_TTL = 60; // window in seconds
const MAX_PROMPT_LENGTH = 2000;
const MAX_SYSTEM_LENGTH = 2000;
const GEMINI_TIMEOUT_MS = 15000;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...extraHeaders,
    },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ reply: "Service temporarily unavailable." }, 503);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse({ reply: "Content-Type must be application/json." }, 415);
    }

    const body = await request.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const system = typeof body?.system === "string" ? body.system.trim() : "";

    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      return jsonResponse({ reply: "Invalid prompt." }, 400);
    }

    if (system.length > MAX_SYSTEM_LENGTH) {
      return jsonResponse({ reply: "System instruction is too long." }, 400);
    }

    /* ── Rate limiting (KV) ─────────────────────────────────── */
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (env.RATE_LIMIT) {
      const key = `rl:${ip}`;
      const raw = await env.RATE_LIMIT.get(key);
      const count = raw ? parseInt(raw, 10) : 0;

      if (count >= RATE_LIMIT_MAX) {
        return jsonResponse(
          { reply: "Too many requests. Please wait a minute and try again." },
          429,
          { "Retry-After": "60" }
        );
      }

      await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL });
    }

    /* ── Gemini call ────────────────────────────────────────── */
    const model = "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });

    const responseText = await r.text();
    let data = {};
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = {};
      }
    }

    if (!r.ok) {
      return jsonResponse(
        {
          reply:
            r.status >= 500
              ? "Upstream AI service is temporarily unavailable."
              : `Gemini API error (${r.status}).`,
        },
        r.status
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim() ||
      "No response";

    return jsonResponse({ reply: text });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      return jsonResponse({ reply: "AI service timeout. Please try again." }, 504);
    }

    return jsonResponse({ reply: "Internal server error." }, 500);
  }
}
