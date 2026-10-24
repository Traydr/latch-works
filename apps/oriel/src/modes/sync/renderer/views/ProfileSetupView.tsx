import { FolderOpen } from "lucide-react";

import type { LockstepProfilePublic } from "../../shared/types";
import type { ProfileFormState } from "../hooks/useLockstepController";

interface ProfileSetupViewProps {
  /** The saved profile being edited; omit to create a new profile. */
  editingProfile?: LockstepProfilePublic | null;
  form: ProfileFormState;
  onCancel: () => void;
  onChange: (patch: Partial<ProfileFormState>) => void;
  onPickFolder: () => void;
  onSubmit: (event: React.FormEvent) => void;
}

const SAVED_TOKEN_PLACEHOLDER = "Saved encrypted in ~/.latch-works";

/** How the edited profile currently holds its token, phrased for the hint under the field. */
function savedTokenHint(profile: LockstepProfilePublic): string | null {
  if (profile.tokenInSession) {
    return "The current token is kept in memory until quit because OS encryption is unavailable.";
  }

  if (profile.tokenUnreadable) {
    return "The saved token could not be unlocked. Enter it again to replace it.";
  }

  return null;
}

export function ProfileSetupView({
  editingProfile,
  form,
  onCancel,
  onChange,
  onPickFolder,
  onSubmit,
}: ProfileSetupViewProps) {
  const hasSavedToken =
    !!editingProfile && (editingProfile.tokenConfigured || editingProfile.tokenUnreadable);

  const tokenPlaceholder = form.clearToken
    ? "The saved token will be forgotten"
    : hasSavedToken
      ? "Leave blank to keep the saved token"
      : SAVED_TOKEN_PLACEHOLDER;

  const tokenHint = editingProfile ? savedTokenHint(editingProfile) : null;

  return (
    <form className="mx-auto w-full max-w-[560px] px-6 pt-6 pb-16" onSubmit={onSubmit}>
      <p className="lw-caption mb-4 px-1">
        {editingProfile
          ? "Changing the source folder or the API URL clears this profile's plan and last run."
          : "A profile pairs a local archive folder with a Pane View server. Name one for each target, such as your own machine and production."}
      </p>

      <div className="lw-card grid gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">Profile name</span>
            <input
              className="lw-input"
              value={form.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Local archive"
              required
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">Pane View API URL</span>
            <input
              className="lw-input"
              value={form.apiUrl}
              onChange={(event) => onChange({ apiUrl: event.target.value })}
              placeholder="http://localhost:3000"
              required
            />
          </label>
        </div>

        <div className="grid gap-1.5">
          <label className="text-[13px] font-medium" htmlFor="profile-source-root">
            Source folder
          </label>
          <div className="flex gap-2">
            <input
              id="profile-source-root"
              className="lw-input"
              value={form.sourceRoot}
              onChange={(event) => onChange({ sourceRoot: event.target.value })}
              placeholder="/path/to/archive"
              required
            />
            <button className="lw-btn lw-btn-secondary" type="button" onClick={onPickFolder}>
              <FolderOpen />
              Choose…
            </button>
          </div>
        </div>

        <div className="grid gap-1.5">
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">Sync API token</span>
            <input
              className="lw-input disabled:opacity-50"
              type="password"
              value={form.token}
              disabled={form.clearToken}
              onChange={(event) => onChange({ token: event.target.value })}
              placeholder={tokenPlaceholder}
            />
          </label>
          {tokenHint ? <p className="lw-caption">{tokenHint}</p> : null}
          {hasSavedToken ? (
            <label className="inline-flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="lw-check"
                checked={form.clearToken}
                onChange={(event) => onChange({ clearToken: event.target.checked, token: "" })}
              />
              Forget the saved token
            </label>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="lw-btn lw-btn-secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="lw-btn lw-btn-primary" type="submit">
          {editingProfile ? "Save changes" : "Save profile"}
        </button>
      </div>
    </form>
  );
}
