export async function onRequestPost({ request, env }) {
  try {
    const { prompt, system } = await request.json();

    if (!prompt) {
      return new Response(JSON.stringify({ reply: "No prompt" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Можно: "gemini-2.0-flash" или "gemini-2.5-flash"
    const model = "gemini-2.0-flash";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    if (system) {
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
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "No response";

    return new Response(JSON.stringify({ reply: text }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ reply: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}