import { describe, expect, it } from "vitest";
import { shouldShowWhatsNew } from "./whatsNew";

describe("shouldShowWhatsNew (Story 10.5)", () => {
  it("a fresh profile never shows the chip, whatever is stored", () => {
    expect(shouldShowWhatsNew(null, "0.1.0", true)).toBe(false);
    expect(shouldShowWhatsNew("0.0.9", "0.1.0", true)).toBe(false);
    expect(shouldShowWhatsNew("0.1.0", "0.1.0", true)).toBe(false);
  });

  it("the same version shows nothing", () => {
    expect(shouldShowWhatsNew("0.1.0", "0.1.0", false)).toBe(false);
  });

  it("an update shows the chip", () => {
    expect(shouldShowWhatsNew("0.1.0", "0.2.0", false)).toBe(true);
  });

  it("a downgrade or a dev build with another version shows the chip", () => {
    expect(shouldShowWhatsNew("0.2.0", "0.1.0", false)).toBe(true);
    expect(shouldShowWhatsNew("0.1.0", "0.1.0-dev", false)).toBe(true);
  });

  it("a profile from before this story (no record) shows the chip", () => {
    expect(shouldShowWhatsNew(null, "0.1.0", false)).toBe(true);
  });

  it("an unknown running version shows nothing", () => {
    expect(shouldShowWhatsNew("0.1.0", null, false)).toBe(false);
    expect(shouldShowWhatsNew(null, null, false)).toBe(false);
    expect(shouldShowWhatsNew(null, "", false)).toBe(false);
  });
});
