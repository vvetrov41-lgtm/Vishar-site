// Adapted from the owner's TattooBodyMap 2D anatomical figure and region paths.
(function(root){
/**
 * Path helpers for the 2D body map.
 *
 * The whole 2D map is authored as vector art in one shared coordinate space so
 * the anatomical base and the interactive zones can never drift apart: both the
 * figure outline and every zone are generated from these helpers against the
 * same viewBox, and the zone layer is clipped by the very same silhouette path
 * that draws the body. That is what keeps the colour overlay inside the figure
 * with no second silhouette and no floating limbs.
 */

/** A point in map space. */


/** A cubic Bézier segment: two control points followed by its end point. */


/**
 * One half of a bilaterally symmetric outline: a start point on the centre
 * line, then cubic segments running down the left side to a second centre-line
 * point.
 */


/** Map viewBox. Extra head/foot room keeps the figure comfortably framed. */
const VIEW = { x: 0, y: -64, w: 420, h: 1112 };

/** Mirror axis — every paired shape is reflected about this vertical line. */
const AXIS = 210;

/** Trim float noise so the emitted path data stays small and diffable. */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

const mx = (x) => 2 * AXIS - x;

/**
 * Build a closed outline from its left half by reflecting the half about the
 * centre axis and walking it back up, so the two sides are symmetric by
 * construction rather than by hand-matched coordinates.
 */
function mirrorOutline(half) {
  const [start, ...segments] = half;
  let d = `M ${n(start[0])} ${n(start[1])}`;
  for (const s of segments) {
    d += ` C ${n(s[0])} ${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])} ${n(s[5])}`;
  }

  // Walk the same segments backwards on the mirrored side: each segment is
  // reversed by swapping its control points and ending on the previous anchor.
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const prev = i === 0 ? start : [segments[i - 1][4], segments[i - 1][5]];
    d += ` C ${n(mx(s[2]))} ${n(s[3])} ${n(mx(s[0]))} ${n(s[1])} ${n(mx(prev[0]))} ${n(prev[1])}`;
  }
  return `${d} Z`;
}

/** Closed outline that is NOT symmetric about the axis, e.g. a single arm. */
function closedOutline(start, segments) {
  let d = `M ${n(start[0])} ${n(start[1])}`;
  for (const s of segments) {
    d += ` C ${n(s[0])} ${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])} ${n(s[5])}`;
  }
  return `${d} Z`;
}

/** Open polyline through the given points, used for the anatomical detail lines. */
function line(points) {
  if (points.length === 0) return "";
  let d = `M ${n(points[0][0])} ${n(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 2] ?? points[i - 1];
    const p1 = points[i - 1];
    const p2 = points[i];
    const p3 = points[i + 1] ?? p2;
    d +=
      ` C ${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)}` +
      ` ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)}` +
      ` ${n(p2[0])} ${n(p2[1])}`;
  }
  return d;
}

/**
 * Closed, smoothly rounded shape through the given points (closed Catmull-Rom
 * converted to cubics). Zones are authored as a handful of anchor points and
 * rounded here, which keeps them organic instead of boxy while staying easy to
 * nudge by hand.
 */
function blob(points, tension = 1) {
  const len = points.length;
  const at = (i) => points[((i % len) + len) % len];
  let d = `M ${n(at(0)[0])} ${n(at(0)[1])}`;
  for (let i = 0; i < len; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    d +=
      ` C ${n(p1[0] + ((p2[0] - p0[0]) / 6) * tension)} ${n(p1[1] + ((p2[1] - p0[1]) / 6) * tension)}` +
      ` ${n(p2[0] - ((p3[0] - p1[0]) / 6) * tension)} ${n(p2[1] - ((p3[1] - p1[1]) / 6) * tension)}` +
      ` ${n(p2[0])} ${n(p2[1])}`;
  }
  return `${d} Z`;
}

/** Reflect a whole path by drawing it again under this transform. */
const MIRROR_TRANSFORM = `translate(${AXIS * 2} 0) scale(-1 1)`;



/**
 * The anatomical base figure — a clean, matched male front/back plate drawn as
 * vector art rather than a raster plate.
 *
 * Both views share one body, so the front and back plates are matched by
 * construction: identical height, identical landmarks, identical zone anchors.
 * The views differ only in their interior definition lines.
 *
 * The trunk is authored as a left half and reflected so the body cannot end up
 * lopsided. The arms are separate closed outlines so hanging arms can overlap
 * the ribcage naturally without forcing the trunk silhouette around them.
 */

/** Left half of the trunk: crown → left side → crotch. */
const TRUNK_HALF = [
  [210, 22],
  [189, 22, 177, 44, 177, 72],
  [177, 95, 183, 113, 193, 125],
  [195, 131, 197, 138, 194, 148],
  [191, 156, 189, 164, 188, 173],
  [176, 177, 156, 182, 136, 190],
  [124, 196, 116, 204, 112, 215],
  [116, 232, 126, 246, 136, 258],
  [130, 273, 126, 289, 125, 307],
  [126, 329, 134, 351, 142, 373],
  [137, 393, 131, 413, 128, 433],
  [127, 447, 128, 459, 130, 473],
  [130, 493, 130, 513, 131, 533],
  [132, 569, 133, 605, 134, 641],
  [135, 664, 136, 679, 137, 693],
  [138, 705, 139, 715, 139, 725],
  [136, 745, 133, 769, 133, 793],
  [134, 825, 139, 861, 144, 891],
  [147, 904, 150, 913, 152, 922],
  [149, 936, 144, 948, 138, 956],
  [133, 963, 135, 969, 144, 969],
  [157, 970, 170, 969, 177, 966],
  [182, 964, 184, 958, 183, 950],
  [182, 940, 181, 931, 181, 922],
  [178, 898, 174, 866, 172, 834],
  [170, 802, 172, 778, 176, 754],
  [179, 734, 181, 718, 182, 706],
  [183, 696, 184, 688, 184, 680],
  [186, 642, 189, 594, 192, 550],
  [193, 518, 194, 496, 196, 488],
  [201, 486, 206, 480, 210, 472],
];

/** The left arm as its own closed loop. */
const ARM_SEGMENTS = [
  [103, 201, 90, 217, 86, 241],
  [84, 261, 86, 277, 89, 291],
  [88, 313, 88, 339, 87, 363],
  [86, 377, 85, 387, 84, 397],
  [82, 419, 78, 443, 76, 465],
  [75, 476, 74, 485, 73, 494],
  [68, 506, 64, 520, 64, 536],
  [65, 558, 69, 576, 74, 588],
  [79, 596, 89, 596, 95, 588],
  [102, 575, 106, 557, 108, 539],
  [104, 523, 102, 509, 100, 497],
  [104, 473, 109, 443, 114, 415],
  [116, 401, 118, 391, 119, 381],
  [122, 355, 125, 323, 128, 295],
  [130, 275, 133, 259, 136, 249],
  [140, 229, 136, 207, 120, 196],
];

const TRUNK = mirrorOutline(TRUNK_HALF);
const ARM = closedOutline([120, 196], ARM_SEGMENTS);



const p = (...points) => line(points);

const HAND_LINES = [
  p([69, 543], [79, 538], [91, 540], [101, 547]),
  p([73, 559], [75, 577], [78, 589]),
  p([83, 556], [84, 574], [86, 587]),
  p([93, 555], [93, 573], [93, 586]),
];

const FRONT_DETAIL = {
  trunk: [
    p([200, 176], [184, 180], [162, 186], [141, 194]),
    p([140, 212], [153, 248], [173, 276], [200, 288]),
    p([132, 296], [141, 301], [148, 303]),
    p([131, 314], [140, 319], [147, 321]),
    p([198, 306], [189, 334], [186, 362], [188, 390], [194, 416], [200, 434]),
    p([190, 334], [198, 337], [206, 338]),
    p([187, 364], [196, 367], [205, 368]),
    p([189, 394], [198, 396], [206, 397]),
    p([136, 434], [160, 452], [184, 466], [202, 476]),
    blob([
      [161, 668],
      [178, 679],
      [176, 702],
      [160, 710],
      [146, 699],
      [147, 677],
    ]),
    p([164, 730], [161, 768], [159, 810], [159, 852]),
    p([172, 911], [177, 919], [178, 927]),
    p([146, 953], [144, 964]),
    p([155, 950], [154, 964]),
    p([164, 949], [164, 963]),
    p([173, 950], [173, 962]),
  ],
  arm: [
    p([112, 206], [99, 226], [95, 252], [97, 278]),
    p([97, 298], [94, 322], [94, 346], [96, 366]),
    p([120, 302], [117, 326], [115, 348], [115, 366]),
    p([87, 394], [96, 402], [107, 400], [113, 392]),
    p([85, 424], [90, 448], [93, 472], [93, 492]),
    ...HAND_LINES,
  ],
  centre: [
    p([186, 54], [198, 43], [222, 43], [234, 54]),
    p([175, 64], [169, 72], [172, 84], [178, 88]),
    p([245, 64], [251, 72], [248, 84], [242, 88]),
    p([192, 128], [200, 138], [220, 138], [228, 128]),
    p([201, 180], [210, 186], [219, 180]),
    p([210, 292], [210, 334], [210, 378], [210, 426]),
    p([204, 380], [210, 386], [216, 380]),
  ],
  dots: [
    { cx: 178, cy: 272, r: 5 },
    { cx: 242, cy: 272, r: 5 },
  ],
};

const BACK_DETAIL = {
  trunk: [
    p([198, 172], [180, 180], [154, 186], [132, 194]),
    p([136, 202], [156, 232], [178, 264], [194, 294]),
    p([134, 216], [152, 225], [170, 235], [182, 246]),
    p([182, 246], [177, 266], [172, 284], [170, 300]),
    p([131, 304], [134, 334], [146, 360], [166, 378], [190, 388]),
    p([197, 316], [194, 352], [194, 390], [197, 424]),
    p([140, 500], [159, 516], [183, 521], [204, 515]),
    p([167, 524], [165, 574], [164, 624], [164, 670]),
    p([145, 680], [159, 689], [177, 687], [188, 678]),
    p([141, 716], [133, 746], [133, 778], [141, 804]),
    p([178, 714], [186, 746], [186, 782], [178, 810]),
    p([162, 710], [161, 752], [162, 794], [164, 830]),
    p([167, 850], [165, 882], [164, 906], [164, 922]),
    p([151, 934], [160, 948], [175, 949], [182, 938]),
  ],
  arm: [
    p([112, 206], [99, 226], [95, 252], [97, 278]),
    p([96, 296], [93, 322], [93, 348], [96, 368]),
    p([122, 300], [119, 326], [117, 348], [116, 366]),
    blob([
      [99, 382],
      [109, 388],
      [107, 402],
      [96, 404],
      [90, 394],
      [92, 385],
    ]),
    p([84, 426], [89, 450], [93, 474], [93, 494]),
    ...HAND_LINES,
  ],
  centre: [
    p([184, 72], [197, 60], [223, 60], [236, 72]),
    p([193, 122], [201, 131], [219, 131], [227, 122]),
    p([210, 178], [210, 250], [210, 330], [210, 408], [210, 440]),
    p([210, 442], [211, 456], [210, 468], [210, 476]),
    p([198, 434], [210, 446], [222, 434]),
  ],
  dots: [
    { cx: 193, cy: 436, r: 2.8 },
    { cx: 227, cy: 436, r: 2.8 },
  ],
};

const FIGURE_DETAIL = {
  front: FRONT_DETAIL,
  back: BACK_DETAIL,
};


/**
 * The 34 interactive zones, drawn against the same coordinate space as the
 * anatomical figure. Zones may overlap, but rendering order makes the later
 * zone own the visible boundary so there are no gaps between neighbours.
 */





const zone = (id, part, paired, points) => ({
  id,
  d: blob(points),
  paired,
  part,
});

const trunk = (id, points) => zone(id, "trunk", false, points);
const trunkPair = (id, points) => zone(id, "trunk", true, points);
const armPair = (id, points) => zone(id, "arm", true, points);

const HEAD = trunk("head", [
  [210, 6],
  [176, 16],
  [158, 56],
  [166, 104],
  [188, 140],
  [210, 154],
  [232, 140],
  [254, 104],
  [262, 56],
  [244, 16],
]);

const SHOULDER = armPair("shoulder", [
  [140, 176],
  [110, 182],
  [82, 210],
  [76, 250],
  [88, 288],
  [116, 294],
  [138, 268],
  [148, 212],
]);

const FOREARM_SHAPE = [
  [114, 392],
  [86, 400],
  [66, 444],
  [62, 490],
  [88, 506],
  [112, 488],
  [122, 438],
];

const HAND = armPair("hand", [
  [92, 496],
  [60, 504],
  [52, 534],
  [62, 564],
  [98, 570],
  [116, 548],
  [114, 516],
]);

const FINGERS = armPair("fingers", [
  [88, 550],
  [58, 558],
  [54, 590],
  [74, 612],
  [102, 608],
  [114, 578],
  [108, 556],
]);

const ELBOW = armPair("elbow", [
  [108, 362],
  [84, 368],
  [74, 390],
  [82, 414],
  [110, 420],
  [128, 406],
  [128, 378],
]);

const WRIST = armPair("wrist", [
  [92, 472],
  [68, 480],
  [60, 498],
  [70, 516],
  [98, 518],
  [114, 500],
  [114, 478],
]);

const KNEE = trunkPair("knee", [
  [162, 656],
  [134, 664],
  [120, 694],
  [132, 728],
  [166, 736],
  [192, 722],
  [198, 688],
  [190, 664],
]);

const ANKLE = trunkPair("ankle", [
  [166, 894],
  [134, 900],
  [126, 924],
  [140, 946],
  [182, 948],
  [200, 930],
  [196, 904],
]);

const FOOT = trunkPair("foot", [
  [164, 924],
  [128, 932],
  [114, 958],
  [124, 986],
  [178, 988],
  [200, 966],
  [198, 938],
]);

const FRONT_REGIONS = [
  HEAD,
  trunk("throat", [
    [210, 116],
    [184, 124],
    [174, 152],
    [186, 184],
    [210, 196],
    [234, 184],
    [246, 152],
    [236, 124],
  ]),
  trunk("collarbone", [
    [210, 148],
    [170, 154],
    [122, 176],
    [116, 214],
    [164, 226],
    [210, 230],
    [256, 226],
    [304, 214],
    [298, 176],
    [250, 154],
  ]),
  trunkPair("ribs", [
    [166, 250],
    [130, 262],
    [108, 306],
    [110, 374],
    [124, 448],
    [156, 464],
    [176, 396],
    [178, 306],
  ]),
  trunkPair("chest", [
    [200, 200],
    [160, 210],
    [140, 240],
    [142, 278],
    [166, 302],
    [202, 308],
    [210, 272],
    [210, 224],
  ]),
  trunk("stomach", [
    [210, 288],
    [170, 296],
    [148, 334],
    [146, 392],
    [164, 434],
    [210, 450],
    [256, 434],
    [274, 392],
    [272, 334],
    [250, 296],
  ]),
  trunk("pelvis", [
    [210, 412],
    [158, 422],
    [132, 452],
    [148, 490],
    [210, 504],
    [272, 490],
    [288, 452],
    [262, 422],
  ]),
  trunkPair("outer_thigh", [
    [170, 436],
    [118, 448],
    [108, 542],
    [114, 626],
    [130, 692],
    [160, 700],
    [168, 614],
    [172, 518],
  ]),
  trunkPair("inner_thigh", [
    [208, 462],
    [176, 474],
    [163, 556],
    [164, 638],
    [172, 694],
    [198, 688],
    [206, 604],
    [210, 508],
  ]),
  KNEE,
  trunkPair("shin", [
    [152, 696],
    [122, 708],
    [110, 782],
    [116, 862],
    [134, 918],
    [158, 916],
    [162, 834],
    [162, 748],
  ]),
  trunkPair("inner_lower_leg", [
    [194, 698],
    [158, 710],
    [152, 786],
    [156, 862],
    [172, 914],
    [196, 910],
    [200, 830],
    [200, 748],
  ]),
  ANKLE,
  FOOT,
  trunk("sternum", [
    [210, 194],
    [190, 202],
    [186, 254],
    [190, 306],
    [210, 320],
    [230, 306],
    [234, 254],
    [230, 202],
  ]),
  trunkPair("areola", [
    [178, 258],
    [164, 272],
    [178, 287],
    [192, 272],
  ]),
  trunkPair("armpit", [
    [152, 218],
    [136, 228],
    [134, 250],
    [148, 264],
    [162, 254],
    [162, 232],
  ]),
  SHOULDER,
  armPair("outer_upper_arm", [
    [110, 252],
    [82, 258],
    [72, 306],
    [78, 360],
    [98, 380],
    [112, 348],
    [114, 294],
  ]),
  armPair("inner_bicep", [
    [140, 248],
    [110, 256],
    [104, 306],
    [108, 360],
    [126, 378],
    [138, 346],
    [146, 288],
  ]),
  armPair("inner_forearm", FOREARM_SHAPE),
  HAND,
  FINGERS,
  ELBOW,
  WRIST,
];

const BACK_REGIONS = [
  HEAD,
  trunkPair("shoulder_blade", [
    [208, 166],
    [164, 172],
    [126, 194],
    [112, 232],
    [124, 282],
    [152, 332],
    [200, 342],
    [214, 258],
    [216, 204],
  ]),
  trunkPair("ribs", [
    [162, 262],
    [130, 272],
    [110, 312],
    [112, 378],
    [126, 450],
    [156, 466],
    [172, 398],
    [174, 312],
  ]),
  trunk("lower_back", [
    [210, 316],
    [160, 330],
    [140, 374],
    [142, 424],
    [164, 458],
    [210, 472],
    [256, 458],
    [278, 424],
    [280, 374],
    [258, 336],
  ]),
  trunkPair("glutes", [
    [208, 416],
    [158, 424],
    [118, 456],
    [118, 508],
    [156, 538],
    [204, 536],
    [212, 484],
  ]),
  trunkPair("hamstring", [
    [208, 482],
    [158, 486],
    [112, 540],
    [110, 628],
    [134, 694],
    [178, 700],
    [200, 636],
    [210, 552],
  ]),
  KNEE,
  trunkPair("calf", [
    [190, 696],
    [140, 708],
    [114, 770],
    [118, 852],
    [140, 914],
    [182, 910],
    [198, 832],
    [200, 752],
  ]),
  ANKLE,
  FOOT,
  trunk("nape", [
    [210, 112],
    [182, 122],
    [172, 152],
    [184, 186],
    [210, 198],
    [236, 186],
    [248, 152],
    [238, 122],
  ]),
  trunk("spine", [
    [210, 170],
    [193, 180],
    [190, 268],
    [192, 368],
    [197, 436],
    [210, 454],
    [223, 436],
    [228, 368],
    [230, 268],
    [227, 180],
  ]),
  SHOULDER,
  armPair("triceps", [
    [142, 246],
    [104, 252],
    [74, 284],
    [70, 332],
    [88, 374],
    [120, 382],
    [140, 350],
    [150, 292],
  ]),
  armPair("outer_forearm", FOREARM_SHAPE),
  HAND,
  FINGERS,
  ELBOW,
  WRIST,
];

const REGIONS = {
  front: FRONT_REGIONS,
  back: BACK_REGIONS,
};

root.TattooBodyGeometry={TRUNK,ARM,FIGURE_DETAIL,REGIONS,VIEW,MIRROR_TRANSFORM};
})(globalThis);
