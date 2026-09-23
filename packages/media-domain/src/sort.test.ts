import { describe, expect, it } from "vitest";
import { compareByName, hashString, sortMediaItems } from "./sort.js";

describe("random ordering", () => {
  it.each([0, 42, 4294967295])("preserves seeded ordering for seed %i", (seed) => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      name: `image-${index}.png`,
      path: index % 2 ? `C:\\archive\\image-${index}.png` : `/archive/image-${index}.png`,
      mtimeMs: index,
    }));

    const original = [...items];

    const expected = [...items].sort((a, b) => {
      const difference = hashString(`${seed}:${a.path}`) - hashString(`${seed}:${b.path}`);

      return difference || compareByName(a, b);
    });

    expect(sortMediaItems(items, "random", seed)).toEqual(expected);
    expect(items).toEqual(original);
  });

  it("breaks score ties by natural name and preserves equal items", () => {
    const items = ["image-10", "image-2", "Image-2", "image-1"].map((name) => ({
      name,
      path: "/same-path",
      mtimeMs: 0,
    }));

    expect(sortMediaItems(items, "random", 42).map((item) => item.name)).toEqual([
      "image-1",
      "image-2",
      "Image-2",
      "image-10",
    ]);
  });
});
