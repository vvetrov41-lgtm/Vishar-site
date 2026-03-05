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
 *
 * If you don't set up KV, the function still works — it just skips the
 * server-side rate limit and relies on the client-side limiter.
 */

const RATE_LIMIT_MAX = 10;   // requests per window
const RATE_LIMIT_TTL = 60;   // window in seconds

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ reply: "Service temporarily unavailable." }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return new Response(
        JSON.stringify({ reply: "Content-Type must be application/json." }),
        { status: 415, headers: { "Content-Type": "application/json" } }
      );
    }

    /* ── Rate limiting (KV) ─────────────────────────────────── */
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (env.RATE_LIMIT) {
      const key = `rl:${ip}`;
      const raw = await env.RATE_LIMIT.get(key);
      const count = raw ? parseInt(raw, 10) : 0;

      if (count >= RATE_LIMIT_MAX) {
        return new Response(
          JSON.stringify({ reply: "Too many requests. Please wait a minute and try again." }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }
        );
      }

      await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL });
    }

    /* ── Input validation ───────────────────────────────────── */
    const { prompt, system } = await request.json();

    if (!prompt || typeof prompt !== "string" || prompt.length > 2000) {
      return new Response(
        JSON.stringify({ reply: "Invalid prompt." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    /* ── Gemini call ────────────────────────────────────────── */
    const model = "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    if (system && typeof system === "string") {
      payload.systemInstruction = { parts: [{ text: system }] };
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    if (!r.ok) {
      return new Response(
        JSON.stringify({
          reply: `Gemini API error (${r.status}): ${data?.error?.message || "Unknown error"}`,
        }),
        { status: r.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "No response";

    return new Response(JSON.stringify({ reply: text }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ reply: "Internal server error." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
