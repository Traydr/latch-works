import { describe, expect, it } from "vitest";
import { REQUIRED_ELEMENT_IDS, TRIAL_LAYOUTS } from "./trial-layouts";

describe("trial layouts", () => {
  it("keeps a stable set of five layouts", () => {
    expect(TRIAL_LAYOUTS).toHaveLength(5);
  });

  for (const layout of TRIAL_LAYOUTS) {
    it(`${layout.name} contains every required element id exactly once`, () => {
      for (const id of REQUIRED_ELEMENT_IDS) {
        const matches = layout.html.match(new RegExp(`id="${id}"`, "g")) ?? [];
        expect(matches, `id ${id} in layout ${layout.name}`).toHaveLength(1);
      }
    });
  }

  it("keeps the log container inside a details element in every layout", () => {
    for (const layout of TRIAL_LAYOUTS) {
      expect(layout.html).toMatch(/<details id="logDetails-mini"/);
      expect(layout.html).toMatch(/<progress id="progressBar-mini"/);
    }
  });
});
