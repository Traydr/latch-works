import { describe, expect, it } from "vitest";
import {
  addProfile,
  DEFAULT_PROFILES,
  GatherProfilesStateSchema,
  removeProfile,
  renameProfile,
  type GatherProfilesState
} from "./profiles";

const THREE: GatherProfilesState = {
  profiles: [
    { id: "default", name: "Default" },
    { id: "work", name: "Work" },
    { id: "art", name: "Art" }
  ],
  activeProfileId: "work"
};

describe("profiles", () => {
  it("falls back to the default profile for a missing or damaged record", () => {
    expect(GatherProfilesStateSchema.parse(undefined)).toEqual(DEFAULT_PROFILES);
    expect(GatherProfilesStateSchema.parse({ profiles: [], activeProfileId: "x" })).toEqual(
      DEFAULT_PROFILES
    );
  });

  it("drops duplicate IDs and restores a missing default, which replaces an unknown active", () => {
    const parsed = GatherProfilesStateSchema.parse({
      profiles: [{ id: "a", name: "  A  " }, { id: "a", name: "Again" }, { id: "b", name: "" }, 7],
      activeProfileId: "missing"
    });

    expect(parsed).toEqual({
      profiles: [
        { id: "default", name: "Default" },
        { id: "a", name: "A" },
        { id: "b", name: "Profile 2" }
      ],
      activeProfileId: "default"
    });
  });

  it("keeps the default profile first and drops the newest profiles over the cap", () => {
    const others = Array.from({ length: 14 }, (_, index) => ({ id: `p${index}`, name: "P" }));

    const parsed = GatherProfilesStateSchema.parse({
      profiles: [...others, { id: "default", name: "Home" }],
      activeProfileId: "p13"
    });

    expect(parsed.profiles.map((profile) => profile.id)).toEqual([
      "default",
      ...others.slice(0, 11).map((profile) => profile.id)
    ]);
    expect(parsed.profiles[0].name).toBe("Home");
    expect(parsed.activeProfileId).toBe("default");
  });

  it("activates the neighbour of a removed active profile and never removes the default", () => {
    expect(removeProfile(THREE, "work")).toEqual({
      profiles: [THREE.profiles[0], THREE.profiles[2]],
      activeProfileId: "art"
    });
    expect(removeProfile(THREE, "default")).toBe(THREE);
  });

  it("keeps the current name when a rename is blank and numbers unnamed profiles", () => {
    expect(renameProfile(THREE, "work", "   ")).toBe(THREE);
    expect(renameProfile(THREE, "work", "  Client   jobs ").profiles[1].name).toBe("Client jobs");
    expect(addProfile(THREE, "new").profiles.at(-1)).toEqual({ id: "new", name: "Profile 4" });
  });
});
