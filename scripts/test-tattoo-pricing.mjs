import assert from "node:assert/strict";
import fs from "node:fs";
import api from "../assets/js/tattoo-pricing.js";
import { renderPricingCopy } from "./lib/pricing-copy.mjs";
const make=(part="forearm",styles=["black_grey"],extra={})=>({areas:[{region:"arm",placements:[part],work:["new"],side:"left",scale:"area",coverage:"panel",other:"",...extra}],styles});
for(const [p,price] of [
 [make(),"£980–£1,960"],[make("upper_arm"),"£1,960–£2,940"],[make("forearm",["black_grey"],{scale:"small"}),"£420–£560"],[make("full_sleeve"),"£5,880–£7,840+"],[make("full_sleeve",["colour"]),"£7,840–£9,800+"],[make("full_sleeve",["black_grey","colour"]),"£5,880–£9,800+"],[make("full_leg_sleeve",["colour"],{region:"leg"}),"£9,800–£11,760+"],[make("full_back",["black_grey"],{region:"back"}),"£5,880–£11,760+"],[make("half_sleeve"),"Individual estimate"],[make("half_sleeve",["black_grey"],{half:"upper"}),"£2,940–£4,900+"],[make("half_sleeve",["black_grey"],{half:"lower"}),"£2,940–£3,920"],[make("half_sleeve",["colour"],{half:"lower"}),"£3,920–£4,900"],[make("three_quarter_sleeve"),"£3,920–£6,860+"],[make("forearm",["black_grey"],{coverage:"wrap"}),"Individual estimate"],[make("forearm",["black_grey"],{work:["extension","rework"]}),"Individual estimate"],[make("full_sleeve",["colour"],{side:"both"}),"Individual estimate"]
]){assert.equal(api.estimate(p).price,price);const b=api.booking(p);assert.deepEqual(api.fromHash("#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)})),b);assert.doesNotMatch(b.notes,/£|Initial guide/);}
assert.equal(api.fromHash("#estimate=2&project=bad"),null);assert.equal(api.estimate(make("forearm",["black_grey"],{side:""})),null);assert.equal(api.estimate(make("forearm",["black_grey"],{work:["new","cover_up"]})),null);assert.equal(api.estimate(make("forearm",["not_sure","colour"])),null);
assert.equal(api.estimate(make("half_sleeve",["black_grey"],{half:"upper"})).provisional,true);
assert.equal(api.estimate(make("full_sleeve")).provisional,false);
assert.deepEqual(api.budgetPlan(2000),{hours:14.25,fullDays:2,remainderHours:.25,unused:5});assert.equal(api.budgetPlan(-1),null);
assert.equal(api.estimate(make("half_sleeve",["black_grey"],{half:"lower"})).provisional,false);
assert.equal(api.estimate(make("full_sleeve",["black_grey"],{placements:["full_sleeve","forearm"]})).numeric,false);
const armLeg={areas:[...make("half_sleeve",["black_grey"],{half:"lower"}).areas,...make("full_leg_sleeve",["black_grey"],{region:"leg"}).areas],styles:["black_grey"]};
assert.equal(api.estimate(armLeg).price,"£10,780–£13,720+");
assert.equal(api.estimate(armLeg).provisional,true);
assert.equal(api.breakdown(armLeg).length,2);
assert.equal(api.breakdown(armLeg)[0].result.price,"£2,940–£3,920");
const torsoArm={areas:[...make("forearm").areas,...make("full_back",["black_grey"],{region:"back"}).areas],styles:["black_grey"]};
assert.equal(api.estimate(torsoArm).numeric,false);
assert.equal(api.breakdown(torsoArm)[0].result.price,"£980–£1,960");
const draftMix={...armLeg,areas:[make("three_quarter_sleeve").areas[0],armLeg.areas[1]]};
assert.equal(api.estimate(draftMix).numeric,false);
const oldInk={...armLeg,areas:[{...armLeg.areas[0],work:["cover_up"]},armLeg.areas[1]]};
assert.equal(api.estimate(oldInk).numeric,false);
assert.equal(api.breakdown(oldInk)[0].result.numeric,false);
let combinations=20;
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
