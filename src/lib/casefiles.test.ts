/**
 * The case files are an external check on the flight model.
 *
 * These marks were not produced by this code and cannot be tuned to. If the
 * model demands an implausible release to reach a published distance, that is a
 * real finding about the model, and it fails here.
 */

import { describe, expect, it } from "vitest";
import { CASE_FILES, caseFileById, cheapestAngleDeg, reconstruct } from "./casefiles";

describe("case file registry", () => {
  it("has unique ids and a source for every entry", () => {
    const ids = CASE_FILES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASE_FILES) {
      expect(c.source).toMatch(/^https?:\/\//);
      expect(c.markM).toBeGreaterThan(30);
      expect(c.markM).toBeLessThan(90);
    }
  });

  it("resolves by id", () => {
    expect(caseFileById("schult-74-08")?.athlete).toBe("Jürgen Schult");
    expect(caseFileById("nope")).toBeUndefined();
  });
});

describe("reconstruction", () => {
  it("hits every published mark to within a centimetre", () => {
    for (const cf of CASE_FILES) {
      const r = reconstruct(cf);
      expect(r.unreachable).toBe(false);
      expect(Math.abs(r.residualM)).toBeLessThan(0.01);
    }
  });

  it("demands a physically plausible release for every mark", () => {
    // Elite discus release speeds sit around 24-27 m/s. Anything outside a
    // generous 18-32 window would mean the aerodynamic model is wrong.
    for (const cf of CASE_FILES) {
      const r = reconstruct(cf);
      expect(r.release.speed).toBeGreaterThan(18);
      expect(r.release.speed).toBeLessThan(32);
    }
  });

  it("needs more speed for a heavier implement at the same distance", () => {
    const men = CASE_FILES.find((c) => c.id === "schult-74-08")!;
    const women = CASE_FILES.find((c) => c.id === "reinsch-76-80")!;
    const rMen = reconstruct(men);
    const rWomen = reconstruct(women);
    // The 1 kg plate goes 2.7 m further off a slower arm than the 2 kg does.
    expect(rWomen.release.speed).toBeLessThan(rMen.release.speed);
  });

  it("flies further into a headwind - the whole reason Ramona matters", () => {
    const ramona = CASE_FILES.find((c) => c.id === "alekna-75-56")!;
    const r = reconstruct(ramona);
    const still = r.windCurve.find((w) => w.headwindMs === 0)!;
    const into = r.windCurve.find((w) => w.headwindMs === 8)!;
    const tail = r.windCurve.find((w) => w.headwindMs === -4)!;
    expect(into.rangeM).toBeGreaterThan(still.rangeM);
    expect(tail.rangeM).toBeLessThan(still.rangeM);
  });

  it("does not show a headwind gain for the shot, which is not a wing", () => {
    const shotCase = {
      ...CASE_FILES[0],
      id: "synthetic-shot",
      implementId: "shot-7.26",
      markM: 22.5,
    };
    const r = reconstruct(shotCase);
    const still = r.windCurve.find((w) => w.headwindMs === 0)!;
    const into = r.windCurve.find((w) => w.headwindMs === 8)!;
    expect(into.rangeM).toBeLessThanOrEqual(still.rangeM);
  });

  // A sweep of 37 reconstructions, each an RK4 integration - past the 5s default.
  it("puts the aerodynamic optimum below the vacuum optimum", { timeout: 30_000 }, () => {
    const cf = CASE_FILES.find((c) => c.id === "alekna-75-56")!;
    const best = cheapestAngleDeg(cf);
    // A lifting body wants a flatter release than a ballistic one.
    expect(best).toBeGreaterThan(26);
    expect(best).toBeLessThan(42);
  });
});
