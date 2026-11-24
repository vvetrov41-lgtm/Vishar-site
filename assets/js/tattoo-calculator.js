(() => {
  const api = window.TattooPricing;
  const field = (id) => document.getElementById(id);
  const p = {
    area: "forearm",
    size: "medium",
    cover: "panel",
    style: "black_grey",
    old: "no",
  };
  let rear = false,
    started = false;
  function options(id, entries) {
    field(id).replaceChildren(
      ...Object.entries(entries).map(
        ([value, label]) => new Option(label, value),
      ),
    );
    field(id).value = p[id];
  }
  // Paired contours share geometry so the left and right sides select the same region.
  const outline = {
    head: "M85 29 Q83 9 100 7 Q117 8 115 29 L113 39 Q108 51 100 52 Q91 49 87 40 Z",
    neck: "M91 47 Q94 62 85 66 L100 76 L115 66 Q106 62 109 47 Q100 58 91 47Z",
    upper:
      "M82 64 Q68 65 62 74 Q56 86 55 98 L45 127 Q47 134 56 133 Q67 118 72 103 Q83 91 82 64Z",
    forearm:
      "M45 126 Q37 137 32 158 L24 182 L31 185 Q43 170 48 158 Q56 145 56 132Z",
    hand: "M24 181 L31 184 L30 195 L33 199 Q33 203 28 201 L23 211 Q19 217 16 211 L18 194Z",
    chest:
      "M82 64 Q89 65 100 72 L118 64 Q129 71 127 90 L122 111 Q109 117 100 110 Q91 117 78 111 L73 90 Q71 72 82 64Z",
    stomach:
      "M78 112 Q90 118 100 112 Q110 118 122 112 Q117 135 123 151 L125 162 Q111 169 100 183 Q89 169 75 162 L77 149 Q82 131 78 112Z",
    back: "M82 64 Q100 72 118 64 Q130 73 126 96 L116 131 Q115 143 124 162 L100 183 L76 162 Q85 144 84 131 L74 96 Q70 75 82 64Z",
    thigh:
      "M75 162 Q87 167 100 183 L96 218 L89 270 Q85 278 78 272 Q78 249 72 224 Q68 188 75 162Z",
    lower:
      "M78 272 Q84 277 89 270 Q92 285 88 306 L80 349 L78 383 L69 384 Q70 363 68 340 Q67 318 72 301Z",
    foot: "M69 381 L79 381 Q78 394 81 401 L78 409 Q71 416 59 411 Q56 408 61 402 L67 392Z",
  };
  function draw() {
    const svg = field("body-map");
    svg.replaceChildren();
    function add(shape, area, mirror) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", outline[shape]);
      if (mirror) path.setAttribute("transform", "translate(200) scale(-1 1)");
      if (area) {
        path.dataset.area = area;
        if (
          p.area === area ||
          (p.cover === "sleeve" && api.areas[area][1] === api.areas[p.area][1])
        )
          path.classList.add("on");
      }
      svg.append(path);
    }
    add("head");
    add("neck");
    if (rear) add("back", "back");
    else {
      add("chest", "chest");
      add("stomach", "stomach");
    }
    for (const mirror of [false, true]) {
      for (const [shape, area] of [
        ["upper", "upper"],
        ["forearm", "forearm"],
        ["hand"],
        ["thigh", "thigh"],
        ["lower", rear ? "calf" : "shin"],
        ["foot"],
      ])
        add(shape, area, mirror);
    }
    field("front").setAttribute("aria-pressed", String(!rear));
    field("rear").setAttribute("aria-pressed", String(rear));
  }
  function event(name) {
    try {
      if (
        location.hostname === "vishartattoo.com" &&
        localStorage.getItem("vishar-cookie-consent") === "granted"
      )
        window.gtag?.("event", name, { calculator_version: 1 });
    } catch {
      /* Storage may be unavailable. */
    }
  }
  function refresh() {
    const choices = api.coverage(p.area, p.size);
    if (!Object.hasOwn(choices, p.cover)) p.cover = "panel";
    options("cover", choices);
    const r = api.estimate(p);
    for (const key of ["price", "time", "visits", "reason"])
      field(key).textContent = r[key];
    field("continue").href =
      "/booking/#" + new URLSearchParams({ estimate: "1", ...p });
    draw();
  }
  function select(id, value) {
    if (!started) {
      event("tattoo_estimate_start");
      started = true;
    }
    p[id] = value;
    if (id === "area") {
      if (["back", "calf"].includes(value)) rear = true;
      if (["chest", "stomach", "shin"].includes(value)) rear = false;
      field("area").value = value;
    }
    refresh();
  }
  options(
    "area",
    Object.fromEntries(
      Object.entries(api.areas).map(([key, a]) => [key, a[0]]),
    ),
  );
  options("style", api.styles);
  options("size", api.sizes);
  for (const id of Object.keys(p))
    field(id).addEventListener("change", (e) => select(id, e.target.value));
  field("body-map").addEventListener("click", (e) => {
    if (e.target.dataset.area) select("area", e.target.dataset.area);
  });
  for (const id of ["front", "rear"])
    field(id).addEventListener("click", () => {
      rear = id === "rear";
      draw();
    });
  field("continue").addEventListener("click", () =>
    event("tattoo_estimate_to_booking"),
  );
  refresh();
  document.querySelector(".planner").hidden = false;
})();
