import * as z from "zod/mini";

/**
 * The profile every install starts with. Its folders keep the storage keys used before profiles
 * existed, so folders remembered by an older build belong to it without a migration. Queue jobs
 * from an older build fall back to it too, so it can be renamed but never deleted.
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
 * the default profile rather than failing, a record missing the default profile gets it back, and
 * an unknown active ID falls back to the first profile.
 */
export const GatherProfilesStateSchema = z.catch(
  z.pipe(
    z.object({
      profiles: z.array(z.catch(z.nullable(GatherProfileSchema), null)),
      activeProfileId: z.catch(z.string(), DEFAULT_PROFILE_ID)
    }),
    z.transform((stored): GatherProfilesState => {
      const seen = new Set<string>();
      let defaultProfile: GatherProfile = { ...DEFAULT_PROFILES.profiles[0] };
      const others: GatherProfile[] = [];

      for (const profile of stored.profiles) {
        if (profile && !seen.has(profile.id)) {
          seen.add(profile.id);

          const named = {
            id: profile.id,
            name: normalizeProfileName(profile.name) || `Profile ${seen.size}`
          };

          if (named.id === DEFAULT_PROFILE_ID) {
            defaultProfile = named;
          } else {
            others.push(named);
          }
        }
      }

      // The default profile always leads the list, and the newest profiles go over the cap.
      const profiles = [defaultProfile, ...others.slice(0, MAX_PROFILES - 1)];
      const active = profiles.find((profile) => profile.id === stored.activeProfileId);

      return { profiles, activeProfileId: (active ?? defaultProfile).id };
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

/**
 * Reads, changes, and writes the profiles, returning what was written. Nothing locks the record
 * between the read and the write, so two pages changing profiles at the same moment can drop one
 * change; edits are made by hand, one click at a time, which keeps that window small.
 */
export async function updateProfiles(
  change: (state: GatherProfilesState) => GatherProfilesState
): Promise<GatherProfilesState> {
  const next = change(await loadProfiles());
  await saveProfiles(next);

  return next;
}

export function getProfileName(state: GatherProfilesState, profileId: string): string | null {
  return state.profiles.find((profile) => profile.id === profileId)?.name ?? null;
}

/** A profile's name when there are several to tell apart. With only one, messages leave it out. */
export function getDistinguishingProfileName(
  state: GatherProfilesState,
  profileId: string
): string | null {
  return state.profiles.length > 1 ? getProfileName(state, profileId) : null;
}

/** IDs of profiles in the previous state that the next one no longer lists. */
export function getRemovedProfileIds(
  previous: GatherProfilesState,
  next: GatherProfilesState
): string[] {
  const kept = new Set(next.profiles.map((profile) => profile.id));

  return previous.profiles.flatMap((profile) => (kept.has(profile.id) ? [] : [profile.id]));
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

/**
 * The default profile cannot be removed, so there is always one left. Removing the active profile
 * activates its neighbour.
 */
export function removeProfile(
  state: GatherProfilesState,
  profileId: string
): GatherProfilesState {
  const index = state.profiles.findIndex((profile) => profile.id === profileId);

  if (index < 0 || profileId === DEFAULT_PROFILE_ID) {
    return state;
  }

  const profiles = state.profiles.filter((profile) => profile.id !== profileId);

  const activeProfileId =
    state.activeProfileId === profileId
      ? profiles[Math.min(index, profiles.length - 1)].id
      : state.activeProfileId;

  return { profiles, activeProfileId };
}

function normalizeProfileName(name: string): string {
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
