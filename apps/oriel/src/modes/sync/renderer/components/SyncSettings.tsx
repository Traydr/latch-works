import { Plus } from "lucide-react";

import { SettingsGroup, SettingsRow } from "../../../../shell/Settings";
import { useShell } from "../../../../shell/shell";
import type { LockstepProfilePublic } from "../../shared/types";
import type { LockstepController } from "../hooks/useLockstepController";

function tokenState(profile: LockstepProfilePublic): string {
  if (profile.tokenUnreadable) {
    return "Token unreadable";
  }

  return profile.tokenConfigured ? "Token saved" : "No token saved";
}

/**
 * Sync's section of Oriel's Settings: the saved profiles, each opening Sync's profile form, and
 * where their tokens are kept.
 */
export function SyncSettings({ ctrl }: { ctrl: LockstepController }) {
  const { closeSettings } = useShell();
  const profiles = ctrl.session.settings?.profiles ?? [];
  const { running } = ctrl.run;

  /** Leaves Settings for Sync's own profile form. */
  const openForm = (open: () => void) => () => {
    closeSettings();
    open();
  };

  return (
    <>
      <SettingsGroup title="Profiles">
        {profiles.map((profile) => (
          <SettingsRow
            key={profile.id}
            label={profile.name}
            description={`${profile.sourceRoot} → ${profile.apiUrl}`}
          >
            <span
              className={`gz-caption ${profile.tokenUnreadable ? "text-red-600 dark:text-red-300" : ""}`}
            >
              {tokenState(profile)}
            </span>
            <button
              type="button"
              className="gz-btn gz-btn-secondary"
              aria-label={`Edit ${profile.name}`}
              disabled={running}
              onClick={openForm(() => ctrl.profile.startEditProfile(profile.id))}
            >
              Edit…
            </button>
          </SettingsRow>
        ))}
        <SettingsRow
          label={profiles.length === 0 ? "No profiles yet" : "New profile"}
          description="A profile pairs a local archive folder with a Pane View server."
        >
          <button
            type="button"
            className="gz-btn gz-btn-secondary"
            disabled={running}
            onClick={openForm(ctrl.profile.startCreateProfile)}
          >
            <Plus />
            Add Profile
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Tokens">
        <SettingsRow
          label="Saved in ~/.latch-works/lockstep"
          description="Encrypted with a key there that only your user account can read."
        />
      </SettingsGroup>
    </>
  );
}
