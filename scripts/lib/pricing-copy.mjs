// All replacements are anchored to pricing language, including JSON-LD copy.
import pricing from "../../assets/js/tattoo-pricing.js";
export function renderPricingCopy(html, page, r = pricing.rules) {
  const band = (key) => r[key].join("–");
  const interval = /\d+(?:–|-|\\u2013)\d+/g;
  function after(prefix, key) {
    html = html.replace(
      new RegExp("(" + prefix + ")" + interval.source, "gi"),
      (_, context) => context + band(key),
    );
  }
  html = html
    .replace(/(hourly rate(?: is)? )(?:£|\\u00a3)\d+/gi, "$1£" + r.hourly)
    .replace(/£\d+(?=\/(?:hour|hr)| per hour)/g, "£" + r.hourly)
    .replace(
      /£\d+ for \d+ hours/g,
      "£" + r.hourly * r.day + " for " + r.day + " hours",
    )
    .replace(/(up to )\d+ hours/gi, "$1" + r.day + " hours")
    .replace(/(full day is up to \d+ hours \()£\d+/gi, "$1£" + r.hourly * r.day)
    .replace(/around \+\d+ sessions/g, "around +" + r.legExtra + " sessions");
  after("smaller ", "small");
  after(
    "(?:forearm|smaller (?:colour pieces|areas?))(?::| \\/ smaller area:)? usually (?:take )?",
    "forearm",
  );
  after("upper arm:? usually (?:takes )?", "upper");
  after(
    "arm sleeve:? usually (?:takes )?",
    page === "colour-realism" ? "colour" : "black_grey",
  );
  after("or (?=\\d+(?:–|-|\\\\u2013)\\d+\\+ (?:for |colour))", "colour");
  after("projects:? often ", "torso");
  return html;
}
