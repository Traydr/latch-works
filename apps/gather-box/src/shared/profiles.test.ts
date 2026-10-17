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

  it("drops duplicate IDs and activates the first profile when the active one is gone", () => {
    const parsed = GatherProfilesStateSchema.parse({
      profiles: [{ id: "a", name: "  A  " }, { id: "a", name: "Again" }, { id: "b", name: "" }, 7],
      activeProfileId: "missing"
    });

    expect(parsed).toEqual({
      profiles: [
        { id: "a", name: "A" },
        { id: "b", name: "Profile 2" }
      ],
      activeProfileId: "a"
    });
  });

  it("activates the neighbour of a removed active profile and never removes the last one", () => {
    expect(removeProfile(THREE, "work")).toEqual({
      profiles: [THREE.profiles[0], THREE.profiles[2]],
      activeProfileId: "art"
    });
    expect(removeProfile(DEFAULT_PROFILES, "default")).toBe(DEFAULT_PROFILES);
  });

  it("keeps the current name when a rename is blank and numbers unnamed profiles", () => {
    expect(renameProfile(THREE, "work", "   ")).toBe(THREE);
    expect(renameProfile(THREE, "work", "  Client   jobs ").profiles[1].name).toBe("Client jobs");
    expect(addProfile(THREE, "new").profiles.at(-1)).toEqual({ id: "new", name: "Profile 4" });
  });
});
