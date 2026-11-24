import assert from "node:assert/strict";
import fs from "node:fs";
import api from "../assets/js/tattoo-pricing.js";
import { renderPricingCopy } from "./lib/pricing-copy.mjs";
const make=(part="forearm",styles=["black_grey"],extra={})=>({areas:[{region:"arm",placements:[part],work:["new"],side:"left",scale:"area",coverage:"panel",other:"",...extra}],styles});
for(const [p,price] of [
 [make(),"£980–£1,960"],[make("upper_arm"),"£1,960–£2,940"],[make("forearm",["black_grey"],{scale:"small"}),"£420–£560"],[make("full_sleeve"),"£5,880–£7,840+"],[make("full_sleeve",["colour"]),"£7,840–£9,800+"],[make("full_sleeve",["black_grey","colour"]),"£5,880–£9,800+"],[make("full_leg_sleeve",["colour"],{region:"leg"}),"£9,800–£11,760+"],[make("full_back",["black_grey"],{region:"back"}),"£5,880–£11,760+"],[make("half_sleeve"),"Individual estimate"],[make("three_quarter_sleeve"),"Individual estimate"],[make("forearm",["black_grey"],{coverage:"wrap"}),"Individual estimate"],[make("forearm",["black_grey"],{work:["extension","rework"]}),"Individual estimate"],[make("full_sleeve",["colour"],{side:"both"}),"Individual estimate"]
]){assert.equal(api.estimate(p).price,price);const b=api.booking(p);assert.deepEqual(api.fromHash("#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)})),b);assert.doesNotMatch(b.notes,/£|Initial guide/);}
assert.equal(api.fromHash("#estimate=2&project=bad"),null);assert.equal(api.estimate(make("forearm",["black_grey"],{side:""})),null);assert.equal(api.estimate(make("forearm",["black_grey"],{work:["new","cover_up"]})),null);assert.equal(api.estimate(make("forearm",["not_sure","colour"])),null);
let combinations=13;
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
