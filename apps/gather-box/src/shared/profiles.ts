import * as z from "zod/mini";

/**
 * The profile every install starts with. Its folders keep the storage keys used before profiles
 * existed, so folders remembered by an older build belong to it without a migration.
 */
export const DEFAULT_PROFILE_ID = "default";

export const MAX_PROFILES = 12;

export const MAX_PROFILE_NAME_LENGTH = 32;

/** A named set of remembered destination folders. */
export interface GatherProfile {
  id: string;
  name: string;
}

export interface GatherProfilesState {
  profiles: GatherProfile[];
  activeProfileId: string;
}

export const DEFAULT_PROFILES: GatherProfilesState = {
  profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default" }],
  activeProfileId: DEFAULT_PROFILE_ID
};

const GatherProfileSchema = z.object({
  id: z.string().check(z.minLength(1)),
  name: z.string()
});

/**
 * Profiles survive extension upgrades and sync between devices, so a damaged record falls back to
 * the default profile rather than failing, and an unknown active ID falls back to the first one.
 */
export const GatherProfilesStateSchema = z.catch(
  z.pipe(
    z.object({
      profiles: z.array(z.catch(z.nullable(GatherProfileSchema), null)),
      activeProfileId: z.catch(z.string(), DEFAULT_PROFILE_ID)
    }),
    z.transform((stored): GatherProfilesState => {
      const seen = new Set<string>();
      const profiles: GatherProfile[] = [];

      for (const profile of stored.profiles) {
        if (profile && !seen.has(profile.id) && profiles.length < MAX_PROFILES) {
          seen.add(profile.id);
          profiles.push({
            id: profile.id,
            name: normalizeProfileName(profile.name) || `Profile ${profiles.length + 1}`
          });
        }
      }

      if (profiles.length === 0) {
        return copyProfiles(DEFAULT_PROFILES);
      }

      return {
        profiles,
        activeProfileId: seen.has(stored.activeProfileId) ? stored.activeProfileId : profiles[0].id
      };
    })
  ),
  () => copyProfiles(DEFAULT_PROFILES)
);

export const PROFILES_KEY = "gather-box-profiles";

export async function loadProfiles(): Promise<GatherProfilesState> {
  const stored = await chrome.storage.sync.get(PROFILES_KEY);

  return GatherProfilesStateSchema.parse(stored[PROFILES_KEY]);
}

export async function saveProfiles(state: GatherProfilesState): Promise<void> {
  await chrome.storage.sync.set({ [PROFILES_KEY]: GatherProfilesStateSchema.parse(state) });
}

/** Reads, changes, and writes the profiles in one step, returning what was written. */
export async function updateProfiles(
  change: (state: GatherProfilesState) => GatherProfilesState
): Promise<GatherProfilesState> {
  const next = change(await loadProfiles());
  await saveProfiles(next);

  return next;
}

export async function loadActiveProfileId(): Promise<string> {
  return (await loadProfiles()).activeProfileId;
}

export function getActiveProfile(state: GatherProfilesState): GatherProfile {
  return state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0];
}

export function getProfileName(state: GatherProfilesState, profileId: string): string | null {
  return state.profiles.find((profile) => profile.id === profileId)?.name ?? null;
}

export function setActiveProfile(
  state: GatherProfilesState,
  profileId: string
): GatherProfilesState {
  return state.profiles.some((profile) => profile.id === profileId)
    ? { ...state, activeProfileId: profileId }
    : state;
}

/** Adds a profile, unnamed ones numbered after the list. Unchanged once the list is full. */
export function addProfile(
  state: GatherProfilesState,
  id: string,
  name = ""
): GatherProfilesState {
  if (state.profiles.length >= MAX_PROFILES) {
    return state;
  }

  const profile = {
    id,
    name: normalizeProfileName(name) || nextProfileName(state)
  };

  return { ...state, profiles: [...state.profiles, profile] };
}

/** A blank name keeps the current one. */
export function renameProfile(
  state: GatherProfilesState,
  profileId: string,
  name: string
): GatherProfilesState {
  const normalized = normalizeProfileName(name);

  if (!normalized) {
    return state;
  }

  return {
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.id === profileId ? { ...profile, name: normalized } : profile
    )
  };
}

/** The last profile cannot be removed. Removing the active one activates its neighbour. */
export function removeProfile(
  state: GatherProfilesState,
  profileId: string
): GatherProfilesState {
  const index = state.profiles.findIndex((profile) => profile.id === profileId);

  if (index < 0 || state.profiles.length === 1) {
    return state;
  }

  const profiles = state.profiles.filter((profile) => profile.id !== profileId);

  const activeProfileId =
    state.activeProfileId === profileId
      ? profiles[Math.min(index, profiles.length - 1)].id
      : state.activeProfileId;

  return { profiles, activeProfileId };
}

export function normalizeProfileName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_PROFILE_NAME_LENGTH).trim();
}

function nextProfileName(state: GatherProfilesState): string {
  const taken = new Set(state.profiles.map((profile) => profile.name.toLowerCase()));
  let number = state.profiles.length + 1;

  while (taken.has(`profile ${number}`)) {
    number += 1;
  }

  return `Profile ${number}`;
}

function copyProfiles(state: GatherProfilesState): GatherProfilesState {
  return { ...state, profiles: state.profiles.map((profile) => ({ ...profile })) };
}
