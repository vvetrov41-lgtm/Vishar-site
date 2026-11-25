import assert from "node:assert/strict";
import fs from "node:fs";
import api from "../assets/js/tattoo-pricing.js";
import { renderPricingCopy } from "./lib/pricing-copy.mjs";
const make=(part="forearm",styles=["black_grey"],extra={})=>({areas:[{region:"arm",placements:[part],work:["new"],side:"left",scale:"area",coverage:"panel",other:"",...extra}],styles});
for(const [p,price] of [
 [make(),"£980–£1,960"],[make("upper_arm"),"£1,960–£2,940"],[make("forearm",["black_grey"],{scale:"small"}),"£420–£560"],[make("full_sleeve"),"£5,880–£7,840+"],[make("full_sleeve",["colour"]),"£7,840–£9,800+"],[make("full_sleeve",["black_grey","colour"]),"£5,880–£9,800+"],[make("full_leg_sleeve",["colour"],{region:"leg"}),"£9,800–£11,760+"],[make("full_back",["black_grey"],{region:"back"}),"£5,880–£11,760+"],[make("half_sleeve"),"Individual estimate"],[make("half_sleeve",["black_grey"],{half:"upper"}),"£2,940–£4,900+"],[make("half_sleeve",["black_grey"],{half:"lower"}),"£2,940–£3,920"],[make("half_sleeve",["colour"],{half:"lower"}),"£3,920–£4,900"],[make("three_quarter_sleeve"),"£3,920–£6,860+"],[make("forearm",["black_grey"],{coverage:"wrap"}),"£2,940–£3,920"],[make("forearm",["black_grey"],{work:["extension","rework"]}),"Individual estimate"],[make("full_sleeve",["colour"],{side:"both"}),"Individual estimate"]
]){assert.equal(api.estimate(p).price,price);const b=api.booking(p);assert.deepEqual(api.fromHash("#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)})),b);assert.doesNotMatch(b.notes,/£|Initial guide/);}
assert.equal(api.fromHash("#estimate=2&project=bad"),null);assert.equal(api.estimate(make("forearm",["black_grey"],{side:""})),null);assert.equal(api.estimate(make("forearm",["black_grey"],{work:["new","cover_up"]})),null);assert.equal(api.estimate(make("forearm",["not_sure","colour"])),null);
assert.equal(api.estimate(make("half_sleeve",["black_grey"],{half:"upper"})).provisional,true);
assert.equal(api.estimate(make("full_sleeve")).provisional,false);
assert.equal(api.estimate(make("full_chest",["black_grey"],{region:"chest_ribs"})).price,"£2,940–£4,900+");
assert.equal(api.estimate(make("full_chest",["colour"],{region:"chest_ribs"})).price,"£3,920–£5,880+");
assert.match(api.booking(make("thigh",["black_grey"],{region:"leg",surface:"outer"})).notes,/Outer surface/);
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
assert.equal(api.breakdown(oldInk)[0].result.numeric,true);
assert.equal(api.breakdown(oldInk)[0].result.price,"£3,920–£4,900");
for(const region of api.REGIONS)for(const [part] of region.placements){if(part==="other")continue;for(const half of api.half(part)?["upper","lower","inner","outer"]:[undefined]){
 const fresh=make(part,["colour"],{region:region.key,half});
 for(const styles of [["black_grey"],["colour"],["black_grey","colour"],["not_sure"]]){const cover=make(part,styles,{region:region.key,half,work:["cover_up"]});const e=api.estimate(cover),b=api.estimate(fresh);assert.equal(e.price,b.price);assert.deepEqual(e.hours,b.hours);assert.deepEqual(e.sessions,b.sessions);assert.equal(e.coverUp,true);assert.equal(e.provisional,true);assert.match(e.reason,/touch-up may be needed after full healing/);assert.deepEqual(api.booking(cover).styles,styles);assert.deepEqual(api.booking(cover).areas[0].work,["cover_up"]);}
 }}
assert.match(api.booking(make("forearm",["black_grey"],{surface:"front"})).notes,/Front surface/);
assert.match(api.booking(make("upper_arm",["black_grey"],{surface:"back"})).notes,/Back surface/);
for(const [region,part] of [["arm","half_sleeve"],["leg","half_leg_sleeve"]])for(const half of ["inner","outer"]){const p=make(part,["black_grey"],{region,half});assert.equal(api.estimate(p).numeric,true);assert.equal(api.estimate(p).provisional,true);assert.match(api.booking(p).notes,new RegExp("Full-length "+half+" side"));assert.deepEqual(api.fromHash("#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)})).project,p);}
assert.equal(api.estimate(make("half_sleeve",["black_grey"],{half:"invalid"})),null);
for(const region of api.REGIONS)for(const [part] of region.placements){if(part==="other")continue;for(const style of ["black_grey","colour"]){const p=make(part,[style],{region:region.key,half:api.half(part)?"lower":undefined});const result=api.estimate(p);assert.ok(result?.numeric,region.key+"|"+part+"|"+style);assert.ok(result.hours[0]>0&&result.hours[1]>=result.hours[0]);}}
for(const [region,part] of [["chest_ribs","ribs"],["chest_ribs","collarbone"],["back","shoulder_blade"],["stomach_sides","side"],["stomach_sides","hip"],["neck_head","side_neck"],["neck_head","behind_ear"]]){const p=make(part,["black_grey"],{region,side:"left"});assert.ok(api.sided(p.areas[0]));assert.ok(api.estimate(p).numeric);assert.equal(api.estimate(make(part,["black_grey"],{region,side:"both"})).numeric,false);}
let combinations=31;
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
  lowerHalf: {black_grey:[23,24],colour:[25,26]},
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
  if(id==="faq"){assert.match(copy,/23–24 sessions in black and grey or 25–26 sessions in colour/);assert.equal((copy.match(/23–24 sessions in black and grey or 25–26 sessions in colour/g)||[]).length,2);}
  assert.ok(
    copy.includes("£170") && copy.includes("11–12") && copy.includes("15–16"),
  );
}
console.log(
  combinations +
    " valid project combinations, booking transfers, FAQ rate changes and boundary cases passed.",
);
