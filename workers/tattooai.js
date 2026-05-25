export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Use POST request", { status: 405 });
    }
    const body = await request.clone().json();
    // Lead / sendIdea — handled before any AI logic
    if (body.type === "lead" || body.type === "sendIdea") {
      if (!body.contact) {
        return Response.json(
          { ok: false, error: "Contact is required." },
          { status: 400, headers: cors }
        );
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return Response.json(
          { ok: false, error: "Telegram is not configured." },
          { status: 500, headers: cors }
        );
      }
      const text = [
        "New tattoo idea from website",
        "",
        "Name: " + (body.name || "—"),
        "Contact: " + body.contact,
        "Preferred reply: " + (body.preferredReply || "—"),
        "Page: " + (body.page || "—"),
        "",
        "Original idea:",
        body.originalIdea || "—",
        "",
        "AI summary:",
        body.aiSummary || "—"
      ].join("\n");
      const tgRes = await fetch(
        "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text
          })
        }
      );
      if (!tgRes.ok) {
        let telegramBody = {};
        try {
          telegramBody = await tgRes.json();
        } catch {
          try { telegramBody = await tgRes.text(); } catch { telegramBody = "unable to read response body"; }
        }
        const safeBody = {
          ok: telegramBody.ok,
          error_code: telegramBody.error_code,
          description: telegramBody.description
        };
        console.error("Telegram sendMessage failed:", JSON.stringify(safeBody));
        return Response.json(
          {
            ok: false,
            error: "Telegram request failed.",
            telegramStatus: tgRes.status,
            telegramError: telegramBody.description || telegramBody
          },
          { status: 502, headers: cors }
        );
      }
      return Response.json(
        { ok: true },
        { status: 200, headers: cors }
      );
    }
    // Existing AI logic — unchanged
    const { type, message } = body;
    const ideaPrompt = "You are the AI Concept Consultant for Vladimir Vishar, a Manchester/Salford-based tattoo artist who works exclusively in realism. Your job is to guide every tattoo idea into Vladimir's realism specialisation.\n\nAllowed new tattoo directions only:\n- colour realism\n- black and grey realism\n- portrait realism\n- wildlife realism\n- dark realism\n- surreal realism\n- cover-up realism\n\nImportant distinction:\nIf the client mentions another style as the desired style for the new tattoo, translate it into the closest allowed realism direction.\nIf the client mentions another style only to describe an existing tattoo, old tattoo, reference, or cover-up target, understand it as context but do not recommend that style for the new tattoo.\n\nExamples:\n- I want an anime portrait → portrait realism with cinematic lighting\n- I want a geometric wolf → wildlife realism with strong black and grey contrast\n- I want a watercolor flower → colour realism with soft natural lighting\n- I want to cover an old tribal band → cover-up realism for an old band tattoo\n- I want to cover an old geometric tattoo → cover-up realism for an existing pattern tattoo\n- I have an old linework snake → cover-up realism or black and grey realism, depending on density\n\nDo not recommend these as new tattoo styles:\nwatercolor, geometric, tribal, neo-traditional, minimalist, linework, illustrative, anime, cartoon, ornamental, dotwork, abstract\n\nAvoid repeating these words in the final answer unless necessary for clarity. Prefer neutral wording:\nexisting tattoo, old tattoo, old band tattoo, previous dark tattoo, existing pattern tattoo, old fine-line tattoo, current design\n\nResponse rules:\n- 120-160 words maximum\n- plain text only\n- no markdown\n- no asterisks\n- no bullet points\n- no numbered lists\n- no emoji\n- calm professional British English\n- never invent prices\n- never invent session times\n- never claim to book the appointment\n\nUse exactly this structure:\n\nConcept:\n\nRealism direction:\n\nPlacement / size:\n\nWhat to send Vladimir:\n\nIn What to send Vladimir, ask for practical references in one sentence: clear photos, placement photo, size idea, lighting mood, and relevant realism references.";
    const systemPrompt =
      type === "aftercare"
        ? "You are a tattoo aftercare assistant. Give safe, general tattoo healing advice. Do not diagnose. If there are signs of infection, allergic reaction, severe pain, pus, fever, spreading redness, or worsening symptoms, tell the user to contact a doctor or their tattoo artist."
        : ideaPrompt;
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return Response.json(response, {
      headers: cors
    });
  }
};
function isAllowedOrigin(origin) {
  if (
    origin === "https://vishartattoo.com" ||
    origin === "https://www.vishartattoo.com"
  ) {
    return true;
  }
  if (origin.endsWith(".vishar-site.pages.dev")) {
    return true;
  }
  return false;
}
function getCorsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "https://vishartattoo.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
