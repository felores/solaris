import { describe, it, expect } from "vitest";
import { spectrumComplement, spectrumHslToRgb } from "./spectrum";

describe("spectrumHslToRgb", () => {
  it("h=0 (red), full saturation, midpoint lightness -> (255,0,0)", () => {
    expect(spectrumHslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
  });

  it("h=120/360 (green), full saturation, midpoint lightness -> (0,255,0)", () => {
    expect(spectrumHslToRgb(120 / 360, 1, 0.5)).toEqual([0, 255, 0]);
  });

  it("h=240/360 (blue), full saturation, midpoint lightness -> (0,0,255)", () => {
    expect(spectrumHslToRgb(240 / 360, 1, 0.5)).toEqual([0, 0, 255]);
  });

  it("zero saturation is a gray at Math.round(l*255) on every channel", () => {
    expect(spectrumHslToRgb(0, 0, 0.5)).toEqual([128, 128, 128]);
    expect(spectrumHslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(spectrumHslToRgb(0, 0, 1)).toEqual([255, 255, 255]);
  });

  it("hue wrap: h=-1/6 is treated like h=5/6 (round-trip safe)", () => {
    expect(spectrumHslToRgb(-1 / 6, 1, 0.5)).toEqual(
      spectrumHslToRgb(5 / 6, 1, 0.5),
    );
  });
});

describe("spectrumComplement", () => {
  it("complement of #ff0000 (red) is cyan #00ffff", () => {
    expect(spectrumComplement("#ff0000")).toBe("#00ffff");
  });

  it("complement of #00ff00 (green) is magenta #ff00ff", () => {
    expect(spectrumComplement("#00ff00")).toBe("#ff00ff");
  });

  it("complement of #0000ff (blue) is yellow #ffff00", () => {
    expect(spectrumComplement("#0000ff")).toBe("#ffff00");
  });

  it("accepts a 6-char hex without the leading #", () => {
    expect(spectrumComplement("ff0000")).toBe("#00ffff");
  });

  it("round-trips: complement(complement(x)) preserves the input hex", () => {
    const cases = ["#58a6ff", "#bd93f9", "#88c0d0", "#7aa2f7", "#fabd2f"];
    for (const c of cases) {
      expect(spectrumComplement(spectrumComplement(c)), c).toBe(c);
    }
  });

  it("returns the amber fallback #f0883e when the input is not a 6-digit hex", () => {
    expect(spectrumComplement("not-a-hex")).toBe("#f0883e");
    expect(spectrumComplement("#xyzxyz")).toBe("#f0883e");
    expect(spectrumComplement("#fff")).toBe("#f0883e");
    expect(spectrumComplement("")).toBe("#f0883e");
  });
});
