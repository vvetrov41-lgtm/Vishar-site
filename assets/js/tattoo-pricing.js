// Shared by the static FAQ build and the two public pages.
(function (root) {
  const rules = {
    hourly: 140,
    day: 7,
    small: [3, 4],
    forearm: [1, 2],
    upper: [2, 3],
    black_grey: [6, 8],
    colour: [8, 10],
    legExtra: 2,
    torso: [6, 12],
  };
  const areas = {
    forearm: ["Forearm", "arm", "forearm"],
    upper: ["Upper arm", "arm", "upper_arm"],
    thigh: ["Thigh", "leg", "thigh"],
    shin: ["Shin", "leg", "shin"],
    calf: ["Calf", "leg", "calf"],
    chest: ["Chest", "chest_ribs", "full_chest"],
    back: ["Back", "back", "full_back"],
    stomach: ["Stomach", "stomach_sides", "stomach"],
  };
  const styles = {
    black_grey: "Black and grey realism",
    colour: "Colour realism",
    not_sure: "Not sure yet",
  };
  const sizes = {
    small: "Small piece",
    medium: "Medium piece",
    large: "Large project",
  };
  function coverage(area, size) {
    const choices = { panel: "One area" };
    if (size === "small") return choices;
    const region = areas[area][1];
    if (["arm", "leg"].includes(region)) {
      choices.wrap = "Wraps around";
      if (size === "large") choices.sleeve = "Full " + region + " sleeve";
    } else if (size === "large") choices.full = "Whole area";
    return choices;
  }
  function valid(p) {
    return (
      p &&
      Object.hasOwn(areas, p.area) &&
      Object.hasOwn(sizes, p.size) &&
      Object.hasOwn(styles, p.style) &&
      Object.hasOwn(coverage(p.area, p.size), p.cover) &&
      ["yes", "no"].includes(p.old)
    );
  }
  const gbp = (n) => "£" + n.toLocaleString("en-GB");
  function estimate(p) {
    if (!valid(p)) return null;
    let sessions,
      hours,
      open = false;
    const review = (reason) => ({
      price: "Photo assessment",
      time: "To be assessed",
      visits: "To be assessed",
      reason,
    });
    if (p.old === "yes")
      return review(
        "Send a close-up and a wider photo in daylight. The darkness and position of the old ink determine what I can cover.",
      );
    if (p.size === "small") {
      hours = rules.small;
      sessions = [1, 1];
    } else if (p.cover === "sleeve") {
      if (p.style === "not_sure")
        return review(
          "Choose colour or black and grey for a sleeve guide, or send your references for advice.",
        );
      const extra = areas[p.area][1] === "leg" ? rules.legExtra : 0;
      sessions = rules[p.style].map((n) => n + extra);
      open = true;
    } else if (p.cover === "full") {
      sessions = rules.torso;
      open = true;
    } else if (p.cover === "panel" && ["upper", "forearm"].includes(p.area))
      sessions = rules[p.area];
    else
      return review(
        "I need to see the scale and references to estimate this placement and coverage.",
      );
    hours ||= sessions.map((n) => n * rules.day);
    const suffix = open ? "+" : "";
    const range = (values, format = String) =>
      format(values[0]) +
      (values[0] === values[1] ? "" : "–" + format(values[1])) +
      suffix;
    return {
      price: range(
        hours.map((n) => n * rules.hourly),
        gbp,
      ),
      time: range(hours) + " hours",
      visits: range(sessions) + (sessions[1] === 1 ? " visit" : " visits"),
      reason:
        p.size === "small"
          ? "A shorter sitting may be possible if the design and detail suit this scale."
          : "Budget assumes full " +
            rules.day +
            "-hour sittings. You pay for tattooing time used." +
            (open ? " Detailed projects may take more sessions." : ""),
    };
  }
  function booking(p) {
    if (!valid(p)) return null;
    const [area, region, part] = areas[p.area];
    const sleeve = p.cover === "sleeve";
    const partial = p.cover !== "full" && ["back", "chest"].includes(p.area);
    const placement = sleeve
      ? region === "arm"
        ? "full_sleeve"
        : "full_leg_sleeve"
      : partial
        ? "other"
        : part;
    const label = sleeve ? coverage(p.area, p.size).sleeve : area;
    const result = estimate(p);
    const notes = [
      sizes[p.size],
      coverage(p.area, p.size)[p.cover],
      "Initial guide: " +
        result.price +
        (result.price === "Photo assessment"
          ? ""
          : " / " + result.time + " / " + result.visits),
    ].join(" · ");
    return {
      region,
      placement,
      label,
      style: p.style,
      work: p.old === "yes" ? "cover_up" : "new",
      notes,
    };
  }
  function fromHash(hash) {
    const params = new URLSearchParams(hash.slice(1));
    if (params.get("estimate") !== "1") return null;
    const p = Object.fromEntries(params);
    return valid(p) ? booking(p) : null;
  }
  const api = {
    rules,
    areas,
    sizes,
    styles,
    coverage,
    valid,
    estimate,
    booking,
    fromHash,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TattooPricing = api;
})(globalThis);
