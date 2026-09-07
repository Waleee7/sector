/**
 * SECTOR - case files.
 *
 * Real, published marks used as targets for the model.
 *
 * WHAT THIS IS: for each mark, SECTOR solves the inverse problem - what release
 * state does this model require in order to produce that distance, with that
 * implement, in that air? The answer is a reconstruction. It is what the physics
 * demands, not what the athlete's arm actually did, and every surface in the app
 * that shows one says so.
 *
 * WHAT THIS IS NOT: a measurement of these throws. Measuring them would need the
 * footage, and broadcast footage of these competitions is not ours to
 * redistribute. Load your own video in Track mode for a measurement.
 *
 * Why bother, then? Because the marks are public and exact, so they are a real
 * external check on the flight model. If the model needs 40 m/s to reach 75.56 m
 * with a 2 kg discus, the model is wrong, and you can see that without owning a
 * single frame of video.
 *
 * The wind numbers are the interesting part. A discus is a wing. Into a
 * headwind its airspeed rises, its lift rises, and it flies FURTHER - which is
 * why both of the marks thrown in Ramona were thrown in wind, and why the
 * counterfactual in each case file is worth dragging.
 */

import {
  airDensity,
  implementById,
  optimalVacuumAngleDeg,
  simulateFlight,
  type ReleaseState,
} from "./physics";

export type CaseFile = {
  id: string;
  athlete: string;
  /** Official distance, metres. */
  markM: number;
  implementId: string;
  event: string;
  venue: string;
  date: string;
  /** Approximate venue elevation, metres. Affects air density, so it affects lift. */
  altitudeM: number;
  tempC: number;
  /** One line on why this mark is worth reconstructing. */
  note: string;
  source: string;
  /** Marks the author's own throw, which the UI frames differently. */
  personal?: boolean;
};

export const CASE_FILES: CaseFile[] = [
  {
    id: "alekna-75-56",
    athlete: "Mykolas Alekna",
    markM: 75.56,
    implementId: "discus-2.0",
    event: "Men's discus — world record",
    venue: "Ramona, Oklahoma, USA",
    date: "13 April 2025",
    altitudeM: 220,
    tempC: 20,
    note: "The first man past 75 metres, thrown in wind at the venue that has now produced two world records. Drag the headwind and watch why athletes travel to Ramona.",
    source: "https://worldathletics.org/news/report/mykolas-alekna-discus-world-record-7556m-ramona",
  },
  {
    id: "alekna-74-35",
    athlete: "Mykolas Alekna",
    markM: 74.35,
    implementId: "discus-2.0",
    event: "Men's discus — world record",
    venue: "Ramona, Oklahoma, USA",
    date: "2024",
    altitudeM: 220,
    tempC: 20,
    note: "The throw that ended the oldest world record in men's track and field, 38 years after it was set.",
    source: "https://athleticsweekly.com/news/jurgen-schults-long-standing-world-discus-record-falls-to-mykolas-alekna-1039977424/",
  },
  {
    id: "schult-74-08",
    athlete: "Jürgen Schult",
    markM: 74.08,
    implementId: "discus-2.0",
    event: "Men's discus — world record 1986–2024",
    venue: "Neubrandenburg, GDR",
    date: "6 June 1986",
    altitudeM: 20,
    tempC: 19,
    note: "Stood for 38 years, in gusty conditions, and outlasted every other world record in men's track and field.",
    source: "https://en.wikipedia.org/wiki/J%C3%BCrgen_Schult",
  },
  {
    id: "reinsch-76-80",
    athlete: "Gabriele Reinsch",
    markM: 76.8,
    implementId: "discus-1.0",
    event: "Women's discus — world record",
    venue: "Neubrandenburg, GDR",
    date: "9 July 1988",
    altitudeM: 20,
    tempC: 22,
    note: "The longest discus throw ever recorded by anyone, with a 1 kg plate. The lightest implement in the list and by far the biggest number.",
    source: "https://www.guinnessworldrecords.com/world-records/farthest-discus-throw-(female)",
  },
  {
    id: "allman-69-50",
    athlete: "Valarie Allman",
    markM: 69.5,
    implementId: "discus-1.0",
    event: "Women's discus — Olympic gold",
    venue: "Paris, France",
    date: "2024",
    altitudeM: 35,
    tempC: 24,
    note: "Her second consecutive Olympic title. A modern championship-winning throw rather than a record chase.",
    source: "https://www.olympics.com/en/news/paris-2024-athletics-usa-valarie-allman-discus-throw",
  },
  {
    id: "stahl-70-47",
    athlete: "Daniel Ståhl",
    markM: 70.47,
    implementId: "discus-2.0",
    event: "Men's discus — World Championships gold",
    venue: "Tokyo, Japan",
    date: "2025",
    altitudeM: 40,
    tempC: 28,
    note: "Warm, dense-enough air and a stadium with no helpful wind. The contrast with Ramona is the whole point.",
    source: "https://en.wikipedia.org/wiki/Daniel_St%C3%A5hl",
  },
  {
    id: "dare-60-66",
    athlete: "Josh Dare",
    markM: 60.66,
    implementId: "discus-1.6",
    event: "Boys' discus — 3rd all-time Georgia HS",
    venue: "Georgia, USA",
    date: "High school",
    altitudeM: 300,
    tempC: 26,
    note: "199 feet with the 1.6 kg high-school plate, and the reason this tool exists. Every number above was invisible to me at the time.",
    source: "https://worldathletics.org",
    personal: true,
  },
];

export function caseFileById(id: string): CaseFile | undefined {
  return CASE_FILES.find((c) => c.id === id);
}

export type Reconstruction = {
  release: ReleaseState;
  /** Attitude used for the fit. */
  attitudeDeg: number;
  headwindMs: number;
  /** Range the model produces at this release - should match the mark. */
  modelledRangeM: number;
  residualM: number;
  /** Flight time and apex that follow from the reconstructed release. */
  flightTimeS: number;
  apexM: number;
  /** What the same release would do with no air at all. */
  vacuumRangeM: number;
  /** Range across a sweep of headwinds, for the counterfactual chart. */
  windCurve: { headwindMs: number; rangeM: number }[];
  /** True when no release speed in the search range reaches the mark. */
  unreachable: boolean;
};

export type ReconstructOptions = {
  releaseAngleDeg?: number;
  releaseHeightM?: number;
  attitudeDeg?: number;
  headwindMs?: number;
};

/** Range for a given release, under one set of conditions. */
function rangeFor(
  speed: number,
  angleDeg: number,
  heightM: number,
  implementId: string,
  attitudeDeg: number,
  headwindMs: number,
  rho: number,
): { rangeM: number; flightTimeS: number; apexM: number } {
  const f = simulateFlight(
    { speed, angleDeg, heightM },
    { implement: implementById(implementId), attitudeDeg, headwindMs, airDensity: rho },
    0.002,
  );
  return { rangeM: f.rangeM, flightTimeS: f.flightTimeS, apexM: f.apexM };
}

/**
 * Solve for the release speed that produces a given official distance.
 *
 * Bisection rather than anything cleverer: range is monotonic in speed for a
 * fixed attitude, the bracket is only ever 10-45 m/s, and 60 halvings of that
 * costs less than a millisecond. A Newton step would need a derivative of an
 * RK4 integration for no measurable gain.
 */
export function reconstruct(cf: CaseFile, opts: ReconstructOptions = {}): Reconstruction {
  const rho = airDensity(cf.altitudeM, cf.tempC);
  const heightM = opts.releaseHeightM ?? 1.75;
  const headwindMs = opts.headwindMs ?? 0;
  // Attitude near the release angle is what a well-delivered discus does: the
  // plate is presented close to flat against the airflow, at a small positive
  // angle of attack.
  const angleDeg = opts.releaseAngleDeg ?? 36;
  const attitudeDeg = opts.attitudeDeg ?? Math.max(0, angleDeg - 8);

  let lo = 10;
  let hi = 45;
  let mid = lo;
  let best = rangeFor(lo, angleDeg, heightM, cf.implementId, attitudeDeg, headwindMs, rho);

  const hiRange = rangeFor(hi, angleDeg, heightM, cf.implementId, attitudeDeg, headwindMs, rho);
  const unreachable = hiRange.rangeM < cf.markM;

  for (let i = 0; i < 60; i++) {
    mid = (lo + hi) / 2;
    best = rangeFor(mid, angleDeg, heightM, cf.implementId, attitudeDeg, headwindMs, rho);
    if (best.rangeM < cf.markM) lo = mid;
    else hi = mid;
  }

  const release: ReleaseState = { speed: mid, angleDeg, heightM };
  const spec = implementById(cf.implementId);
  const vac = simulateFlight(
    release,
    { implement: { ...spec, aero: false }, attitudeDeg, headwindMs: 0, airDensity: 0 },
    0.002,
  );

  const windCurve = [-4, -2, 0, 2, 4, 6, 8, 10].map((w) => ({
    headwindMs: w,
    rangeM: rangeFor(mid, angleDeg, heightM, cf.implementId, attitudeDeg, w, rho).rangeM,
  }));

  return {
    release,
    attitudeDeg,
    headwindMs,
    modelledRangeM: best.rangeM,
    residualM: best.rangeM - cf.markM,
    flightTimeS: best.flightTimeS,
    apexM: best.apexM,
    vacuumRangeM: vac.rangeM,
    windCurve,
    unreachable,
  };
}

/**
 * The release angle that needs the least speed to reach the mark.
 *
 * Not the vacuum optimum: a discus generates lift, so the aerodynamic optimum
 * sits below it, and by how much depends on the plate and the air. Searching is
 * cheaper than deriving.
 */
export function cheapestAngleDeg(cf: CaseFile, opts: ReconstructOptions = {}): number {
  let bestAngle = 36;
  let bestSpeed = Infinity;
  for (let a = 26; a <= 44; a += 0.5) {
    const r = reconstruct(cf, { ...opts, releaseAngleDeg: a });
    if (!r.unreachable && r.release.speed < bestSpeed) {
      bestSpeed = r.release.speed;
      bestAngle = a;
    }
  }
  return bestAngle;
}

/** Vacuum optimum for the reconstructed release, for side-by-side comparison. */
export function vacuumOptimumDeg(r: Reconstruction): number {
  return optimalVacuumAngleDeg(r.release.speed, r.release.heightM);
}
