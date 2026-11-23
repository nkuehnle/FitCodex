import { describe, expect, it } from "vitest";
import { loadPosition } from "./BodyMap";

describe("loadPosition", () => {
  const t: [number, number] = [10, 20];
  it("is red by 75% of the minimum and near-black at the maximum", () => {
    expect(loadPosition(0, t)).toBe(0);
    expect(loadPosition(7.5, t)).toBeCloseTo(0.65);
    expect(loadPosition(12, t)).toBeCloseTo(0.76);
    expect(loadPosition(16, t)).toBeCloseTo(0.88);
    expect(loadPosition(20, t)).toBe(1);
    expect(loadPosition(30, t)).toBe(1);
  });
  it("only ever gets darker", () => {
    let last = 0;
    for (let v = 0; v <= 25; v += 0.5) {
      const p = loadPosition(v, t);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});
