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
    const body = await request.clone().json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json(
        { ok: false, error: "A valid JSON request is required." },
        { status: 400, headers: cors }
      );
    }
    // Personal London booking form — forwarded to Telegram only, nothing is stored.
    if (body.type === "tattoo-enquiry") {
      if (cleanText(body.website, 200)) {
        return Response.json({ ok: true }, { status: 200, headers: cors });
      }

      const startedAt = Number(body.startedAt);
      if (!Number.isFinite(startedAt) || Date.now() - startedAt < 1500) {
        return Response.json(
          { ok: false, error: "Please review the form and try again." },
          { status: 400, headers: cors }
        );
      }

      const enquiry = {
        name: cleanText(body.name, 120),
        email: cleanText(body.email, 320),
        phone: cleanText(body.phone, 80),
        instagram: cleanText(body.instagram, 80),
        preferredReply: cleanText(body.preferredReply, 40),
        travellingFrom: cleanText(body.travellingFrom, 120),
        projectType: cleanText(body.projectType, 100),
        placement: cleanText(body.placement, 160),
        size: cleanText(body.size, 120),
        coverUp: cleanText(body.coverUp, 40),
        timing: cleanText(body.timing, 160),
        idea: cleanText(body.idea, 3500),
        source: cleanText(body.source, 100) || "/booking/"
      };
      if (!enquiry.name || !enquiry.email || !enquiry.preferredReply || !enquiry.projectType || !enquiry.placement || !enquiry.size || !enquiry.coverUp || !enquiry.idea) {
        return Response.json(
          { ok: false, error: "Please complete all required fields." },
          { status: 400, headers: cors }
        );
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enquiry.email)) {
        return Response.json(
          { ok: false, error: "A valid email is required." },
          { status: 400, headers: cors }
        );
      }
      const allowedReplyMethods = new Set(["Email", "WhatsApp", "Instagram"]);
      if (!allowedReplyMethods.has(enquiry.preferredReply)) {
        return Response.json(
          { ok: false, error: "Please choose Email, WhatsApp or Instagram as the preferred reply." },
          { status: 400, headers: cors }
        );
      }
      if (enquiry.preferredReply === "WhatsApp" && !enquiry.phone) {
        return Response.json(
          { ok: false, error: "A WhatsApp number is required when WhatsApp is selected." },
          { status: 400, headers: cors }
        );
      }
      if (enquiry.preferredReply === "Instagram" && !enquiry.instagram) {
        return Response.json(
          { ok: false, error: "An Instagram username is required when Instagram is selected." },
          { status: 400, headers: cors }
        );
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return Response.json(
          { ok: false, error: "Telegram is not configured." },
          { status: 500, headers: cors }
        );
      }

      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length < 1 || images.length > 3) {
        return Response.json(
          { ok: false, error: "Please attach 1–3 reference images." },
          { status: 400, headers: cors }
        );
      }
      const referenceImages = [];
      for (const image of images) {
        const verifiedImage = verifyReferenceImage(image);
        if (!verifiedImage) {
          return Response.json(
            { ok: false, error: "One of the reference images is invalid, too large or has the wrong file type." },
            { status: 400, headers: cors }
          );
        }
        referenceImages.push(verifiedImage);
      }

      const enquiryText = [
        "NEW LONDON TATTOO ENQUIRY",
        "",
        "Name: " + enquiry.name,
        "Email: " + enquiry.email,
        "Phone / WhatsApp: " + (enquiry.phone || "—"),
        "Instagram: " + (enquiry.instagram || "—"),
        "Preferred reply: " + enquiry.preferredReply,
        "Travelling from: " + (enquiry.travellingFrom || "—"),
        "",
        "Project: " + enquiry.projectType,
        "Placement: " + enquiry.placement,
        "Size: " + enquiry.size,
        "Cover-up: " + enquiry.coverUp,
        "Preferred timing: " + (enquiry.timing || "—"),
        "",
        "Idea:",
        enquiry.idea,
        "",
        "Reference images: " + images.length,
        "Source: " + enquiry.source
      ].join("\n").slice(0, 4090);

      const messageResponse = await fetch(
        "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: enquiryText, disable_web_page_preview: true })
        }
      );
      if (!messageResponse.ok) {
        console.error("Telegram sendMessage failed for tattoo-enquiry:", messageResponse.status);
        return Response.json(
          { ok: false, error: "Telegram request failed." },
          { status: 502, headers: cors }
        );
      }

      let failedImageCount = 0;
      for (let index = 0; index < referenceImages.length; index += 1) {
        try {
          const image = referenceImages[index];
          const upload = new FormData();
          upload.append("chat_id", env.TELEGRAM_CHAT_ID);
          upload.append("caption", "Reference " + (index + 1) + " of " + referenceImages.length + " — " + enquiry.name);
          upload.append("document", new Blob([image.bytes], { type: image.type }), safeFilename(index, image.extension));
          const imageResponse = await fetch(
            "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendDocument",
            { method: "POST", body: upload }
          );
          if (!imageResponse.ok) failedImageCount += 1;
        } catch (error) {
          failedImageCount += 1;
          console.error("Reference upload failed for tattoo-enquiry:", String(error));
        }
      }

      return Response.json(
        { ok: true, imageWarning: failedImageCount > 0, failedImageCount },
        { status: 200, headers: cors }
      );
    }
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
    // Book waitlist — forwarded to Telegram only, nothing is stored
    if (body.type === "book-waitlist") {
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 320) : "";
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json(
          { ok: false, error: "A valid email is required." },
          { status: 400, headers: cors }
        );
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return Response.json(
          { ok: false, error: "Telegram is not configured." },
          { status: 500, headers: cors }
        );
      }
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      const waitlistText = [
        "📘 Book waitlist",
        "",
        "Book: " + (body.book || "Composition & Light in Tattooing"),
        "Name: " + (name || "—"),
        "Email: " + email,
        "Source: " + (body.source || "/book/")
      ].join("\n");
      const waitlistRes = await fetch(
        "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: waitlistText
          })
        }
      );
      if (!waitlistRes.ok) {
        console.error("Telegram sendMessage failed for book-waitlist:", waitlistRes.status);
        return Response.json(
          { ok: false, error: "Telegram request failed." },
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
    const ideaPrompt = "You are the AI Concept Consultant for Vladimir Vishar, a London tattoo artist who works exclusively in realism. Your job is to guide every tattoo idea into Vladimir's realism specialisation.\n\nAllowed new tattoo directions only:\n- colour realism\n- black and grey realism\n- portrait realism\n- wildlife realism\n- dark realism\n- surreal realism\n- cover-up realism\n\nImportant distinction:\nIf the client mentions another style as the desired style for the new tattoo, translate it into the closest allowed realism direction.\nIf the client mentions another style only to describe an existing tattoo, old tattoo, reference, or cover-up target, understand it as context but do not recommend that style for the new tattoo.\n\nExamples:\n- I want an anime portrait → portrait realism with cinematic lighting\n- I want a geometric wolf → wildlife realism with strong black and grey contrast\n- I want a watercolor flower → colour realism with soft natural lighting\n- I want to cover an old tribal band → cover-up realism for an old band tattoo\n- I want to cover an old geometric tattoo → cover-up realism for an existing pattern tattoo\n- I have an old linework snake → cover-up realism or black and grey realism, depending on density\n\nDo not recommend these as new tattoo styles:\nwatercolor, geometric, tribal, neo-traditional, minimalist, linework, illustrative, anime, cartoon, ornamental, dotwork, abstract\n\nAvoid repeating these words in the final answer unless necessary for clarity. Prefer neutral wording:\nexisting tattoo, old tattoo, old band tattoo, previous dark tattoo, existing pattern tattoo, old fine-line tattoo, current design\n\nResponse rules:\n- 120-160 words maximum\n- plain text only\n- no markdown\n- no asterisks\n- no bullet points\n- no numbered lists\n- no emoji\n- calm professional British English\n- never invent prices\n- never invent session times\n- never claim to book the appointment\n\nUse exactly this structure:\n\nConcept:\n\nRealism direction:\n\nPlacement / size:\n\nWhat to send Vladimir:\n\nIn What to send Vladimir, ask for practical references in one sentence: clear photos, placement photo, size idea, lighting mood, and relevant realism references.";
    const aftercarePrompt = `You are Vladimir Vishar's tattoo aftercare assistant.

Use Vladimir Vishar's aftercare rules as the source of truth. Do not give generic tattoo advice if it conflicts with these rules.

Keep answers short, clear and practical. Use simple English.

First identify the aftercare option:
1. No film / normal dressing.
2. Healing film / second skin.

If the user does not know, ask which one they have.

For urgent or worrying symptoms, give safety advice first. Do not delay medical advice by asking which option they have.

Core rule:
Clean hands. Quick wash. Pat dry. Very thin moisturiser. Keep friction low.

No film / normal dressing:
Evening finish: keep first dressing on until morning.
Daytime finish: before bed wash thoroughly and cover again with cling film or a clean disposable absorbent pad.
Day 1: wash hands, remove dressing, quick lukewarm shower, mild fragrance-free soap, do not scrub, pat dry with clean paper towel, very thin moisturiser.
While weeping: repeat 3-5 times daily. Wash hands, wash tattoo gently but thoroughly, pat dry, very thin moisturiser, fresh breathable dressing.
Use a disposable absorbent pad for sleep, travel or under clothing. Change when damp.
Let the skin breathe when safe at home.
When weeping stops, usually day 2-4, stop dressings. Moisturise lightly. Do not pick or scratch.

Moisturiser:
Use a very thin layer. More is not better.
Bepanthen Tattoo is recommended but contains lanolin. If sensitive or allergic, use a lanolin-free alternative.
Tattoo should look lightly moisturised, not wet or greasy.
Too much moisturiser can irritate skin and slow healing.

Healing film / second skin:
Use only if tattoo was covered with second skin / healing film.
Keep film on 3-5 days.
Up to 7 days is OK only if comfortable, sealed and not irritated.
Showers are fine. Avoid long hot steam.
Remove early and switch to no-film care if fluid leaks or builds up heavily, film burns/stings/feels very irritated, edges lift and tattoo is no longer sealed, or rash/blisters appear.
After removal, follow no-film care.
Do not re-wrap with film unless Vladimir specifically said so.
Remove slowly. Do not rip it off. If skin pulls too much, change angle and slow down.

Avoid:
Until fully healed: baths, pools, hot tubs, lakes, sea water, saunas, steam rooms, shaving/self-tan on tattoo, scratching, picking, peeling scabs, tight synthetics, strong friction, dirty surfaces, gym benches, animal fur.
First 48h: avoid alcohol.
First 3-7 days: avoid intense workouts.
First 3-4 weeks: avoid direct sun and sunbeds.
After healing: use SPF 50 in strong sun.

Usually normal:
Mild redness, mild swelling, soreness, short warmth, clear or pink fluid mixed with ink, itching, peeling, small scabs.

Unclear rash, bumps or itchy spots:
Do not diagnose or guess the cause. Do not say they are scabs, ingrown hairs, blocked pores, allergy, infection, or usually normal.
Say that bumps or a rash can happen for different reasons during healing, but you cannot identify the cause from a message.
Advise: do not scratch or pick, keep the tattoo clean, pat dry with a clean paper towel, use only a very thin layer of moisturiser, and reduce moisturiser if the tattoo looks wet or greasy.
Avoid tight clothing, trapped sweat, friction, animal fur, gym benches, dirty surfaces, shaving, and self-tan on the tattooed area.
Tell the client to message Vladimir with a clear daylight photo if unsure.
Tell the client to contact NHS 111 / a doctor if the rash spreads, blisters appear, skin becomes very hot, redness spreads, pus, bad smell, heavy discharge, fever, chills, or red streaks appear.

Medical safety:
Message Vladimir if unsure.
Tell the client to contact NHS 111 / a doctor if pain or redness gets worse after 48h, redness spreads, skin feels very hot, pus, bad smell or heavy discharge appears, fever, chills or red streaks appear, or severe rash/blisters appear.
If symptoms feel urgent or severe, tell them not to wait for Vladimir's reply.
Do not diagnose infection, allergy or medical conditions.
This is practical aftercare advice, not medical advice.

Large tattoos:
Large tattoos can stay sore and swollen longer. Rest helps. Friction makes healing harder. The first 3 days matter most. Swelling may be stronger around joints.

Touch-up:
Wait until fully healed before judging the result. Send a clear healed photo after 4-6 weeks if something needs checking. Use daylight and no filters.`;
    const systemPrompt =
      type === "aftercare"
        ? aftercarePrompt
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

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, maxLength);
}

function verifyReferenceImage(image) {
  if (!image || typeof image.data !== "string" || image.data.length > 5_600_000) return null;

  let bytes;
  try {
    bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }

  const detected = detectImageType(bytes);
  if (!detected || detected.type !== image.type) return null;
  return { bytes, type: detected.type, extension: detected.extension };
}

function detectImageType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { type: "image/png", extension: "png" };
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { type: "image/webp", extension: "webp" };
  }
  return null;
}

function safeFilename(index, extension) {
  return "reference-" + (index + 1) + "." + extension;
}
