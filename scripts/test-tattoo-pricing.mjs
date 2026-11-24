import assert from "node:assert/strict";
import fs from "node:fs";
import api from "../assets/js/tattoo-pricing.js";
import { renderPricingCopy } from "./lib/pricing-copy.mjs";
const base = {
  area: "forearm",
  size: "medium",
  cover: "panel",
  style: "black_grey",
  old: "no",
};
for (const [changes, price] of [
  [{}, "£980–£1,960"],
  [{ area: "upper" }, "£1,960–£2,940"],
  [{ size: "small" }, "£420–£560"],
  [{ size: "large", cover: "sleeve" }, "£5,880–£7,840+"],
  [{ size: "large", cover: "sleeve", style: "colour" }, "£7,840–£9,800+"],
  [
    { area: "calf", size: "large", cover: "sleeve", style: "colour" },
    "£9,800–£11,760+",
  ],
  [{ area: "back", size: "large", cover: "full" }, "£5,880–£11,760+"],
  [{ old: "yes" }, "Photo assessment"],
  [{ cover: "wrap" }, "Photo assessment"],
])
  assert.equal(api.estimate({ ...base, ...changes }).price, price);
let combinations = 0;
for (const area of Object.keys(api.areas))
  for (const size of Object.keys(api.sizes))
    for (const cover of Object.keys(api.coverage(area, size)))
      for (const style of Object.keys(api.styles))
        for (const old of ["yes", "no"]) {
          const p = { area, size, cover, style, old };
          const fields = api.booking(p);
          assert.deepEqual(
            api.fromHash("#" + new URLSearchParams({ estimate: 1, ...p })),
            fields,
          );
          assert.ok(fields.notes.length <= 120);
          assert.ok(api.estimate(p).reason);
          combinations++;
        }
assert.equal(api.fromHash("#estimate=1&area=constructor"), null);
assert.equal(api.estimate({ ...base, cover: "sleeve" }), null);
// Mutate all bands together to catch stale visible FAQ answers and JSON-LD.
const change = {
  hourly: 170,
  day: 9,
  forearm: [11, 12],
  upper: [13, 14],
  small: [15, 16],
  black_grey: [17, 18],
  colour: [19, 20],
  torso: [21, 22],
  legExtra: 5,
};
for (const [file, id] of [
  ["faq", "faq"],
  ["colour-realism-tattoo-london", "colour-realism"],
  ["black-and-grey-realism-london", "black-grey"],
]) {
  const copy = renderPricingCopy(
    fs.readFileSync(file + "/index.html", "utf8"),
    id,
    change,
  );
  assert.doesNotMatch(
    copy,
    /£140|(?:1–2|2–3) full-day|(?:6–8|8–10|6–12)\+|3–4 hour projects|up to 7 hours|around \+2 sessions/,
  );
  assert.ok(
    copy.includes("£170") && copy.includes("11–12") && copy.includes("15–16"),
  );
}
console.log(
  combinations +
    " valid project combinations, booking transfers, FAQ rate changes and boundary cases passed.",
);
