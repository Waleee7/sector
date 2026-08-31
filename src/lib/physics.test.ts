import { describe, expect, it } from "vitest";
import {
  G,
  aeroEfficiency,
  airDensity,
  dragCoefficient,
  implementById,
  inferAttitudeDeg,
  liftCoefficient,
  optimalVacuumAngleDeg,
  releaseFromEndpoints,
  simulateFlight,
  vacuumApex,
  vacuumRange,
  type ReleaseState,
} from "./physics";

const RHO = 1.225;

describe("vacuum ballistics", () => {
  it("reproduces the textbook range for a ground-level 45 degree launch", () => {
    const r: ReleaseState = { speed: 20, angleDeg: 45, heightM: 0 };
    // v^2 sin(2a) / g
    expect(vacuumRange(r)).toBeCloseTo((20 * 20 * Math.sin(Math.PI / 2)) / G, 6);
  });

  it("puts the optimal angle below 45 degrees once release is above the ground", () => {
    expect(optimalVacuumAngleDeg(20, 0)).toBeCloseTo(45, 6);
    expect(optimalVacuumAngleDeg(20, 1.7)).toBeLessThan(45);
    expect(optimalVacuumAngleDeg(20, 1.7)).toBeGreaterThan(40);
  });

  it("inverts endpoints back to the release that produced them", () => {
    const r: ReleaseState = { speed: 23.4, angleDeg: 35.5, heightM: 1.62 };
    const range = vacuumRange(r);
    const rad = (r.angleDeg * Math.PI) / 180;
    const vz = r.speed * Math.sin(rad);
    const t = (vz + Math.sqrt(vz * vz + 2 * G * r.heightM)) / G;

    const back = releaseFromEndpoints(r.heightM, range, t);
    expect(back.speed).toBeCloseTo(r.speed, 6);
    expect(back.angleDeg).toBeCloseTo(r.angleDeg, 6);
  });

  it("computes apex", () => {
    expect(vacuumApex({ speed: 20, angleDeg: 90, heightM: 0 })).toBeCloseTo(400 / (2 * G), 6);
  });
});

describe("discus aerodynamic coefficients", () => {
  it("brackets the published drag endpoints", () => {
    expect(dragCoefficient(0)).toBeCloseTo(0.06, 6);
    expect(dragCoefficient(Math.PI / 2)).toBeGreaterThan(1.0);
  });

  it("peaks lift near 30 degrees of attack and vanishes edge-on", () => {
    expect(liftCoefficient(0)).toBeCloseTo(0, 6);
    const at30 = Math.abs(liftCoefficient((30 * Math.PI) / 180));
    expect(at30).toBeGreaterThan(0.85);
    expect(at30).toBeLessThan(1.1);
    // Past stall the model must fall away, not keep climbing.
    expect(Math.abs(liftCoefficient((70 * Math.PI) / 180))).toBeLessThan(at30);
  });
});

describe("aerodynamic flight", () => {
  const discus = implementById("discus-1.6");
  const shot = implementById("shot-5.44");
  const release: ReleaseState = { speed: 23.4, angleDeg: 35.5, heightM: 1.62 };

  it("leaves a shot put essentially ballistic", () => {
    const sim = simulateFlight(release, {
      implement: shot,
      attitudeDeg: 0,
      headwindMs: 0,
      airDensity: RHO,
    });
    const vac = vacuumRange(release);
    // Drag on a 5.44 kg sphere costs a little, but not metres.
    expect(sim.rangeM).toBeLessThan(vac);
    expect(sim.rangeM).toBeGreaterThan(vac * 0.97);
  });

  it("makes a well-struck discus fly FURTHER than a vacuum parabola", () => {
    const sim = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 27,
      headwindMs: 0,
      airDensity: RHO,
    });
    expect(sim.rangeM).toBeGreaterThan(vacuumRange(release));
    expect(aeroEfficiency(sim.rangeM, release)).toBeGreaterThan(1.0);
  });

  it("gains distance into a headwind - the result every thrower knows and no parabola predicts", () => {
    const still = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 27,
      headwindMs: 0,
      airDensity: RHO,
    }).rangeM;
    const head = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 27,
      headwindMs: 5,
      airDensity: RHO,
    }).rangeM;
    const tail = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 27,
      headwindMs: -5,
      airDensity: RHO,
    }).rangeM;

    expect(head).toBeGreaterThan(still);
    expect(tail).toBeLessThan(still);
  });

  it("loses distance when the plate is thrown flat or stalled", () => {
    const good = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 27,
      headwindMs: 0,
      airDensity: RHO,
    }).rangeM;
    const stalled = simulateFlight(release, {
      implement: discus,
      attitudeDeg: 65,
      headwindMs: 0,
      airDensity: RHO,
    }).rangeM;
    expect(stalled).toBeLessThan(good);
  });

  it("recovers the attitude that produced an observed range", () => {
    const truth = 24;
    const sim = simulateFlight(release, {
      implement: discus,
      attitudeDeg: truth,
      headwindMs: 2,
      airDensity: RHO,
    });
    const found = inferAttitudeDeg(release, sim.rangeM, {
      implement: discus,
      headwindMs: 2,
      airDensity: RHO,
    });
    expect(found).not.toBeNull();
    expect(found!).toBeCloseTo(truth, 0);
  });
});

describe("air density", () => {
  it("thins with altitude and warmth", () => {
    const sea = airDensity(0, 15);
    expect(sea).toBeCloseTo(1.225, 2);
    expect(airDensity(1600, 15)).toBeLessThan(sea);
    expect(airDensity(0, 35)).toBeLessThan(sea);
  });
});
