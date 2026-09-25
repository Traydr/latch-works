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

const SAVED_TOKEN_PLACEHOLDER = "Saved with OS encryption when available";

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
    <section className="prism-section">
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">
          {editingProfile ? "Edit profile" : "Profile setup"}
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {editingProfile
            ? "Changing the source folder or API URL clears this profile's plan and last run."
            : "Named profiles let you switch between local and production targets."}
        </p>
      </div>

      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="prism-label">Profile name</span>
            <input
              className="prism-input"
              value={form.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Local archive"
              required
            />
          </label>
          <label className="grid gap-1.5">
            <span className="prism-label">Pane View API URL</span>
            <input
              className="prism-input"
              value={form.apiUrl}
              onChange={(event) => onChange({ apiUrl: event.target.value })}
              placeholder="http://localhost:3000"
              required
            />
          </label>
        </div>

        <div className="grid gap-1.5">
          <label className="prism-label" htmlFor="profile-source-root">
            Source folder
          </label>
          <div className="flex gap-2">
            <input
              id="profile-source-root"
              className="prism-input"
              value={form.sourceRoot}
              onChange={(event) => onChange({ sourceRoot: event.target.value })}
              placeholder="/path/to/archive"
              required
            />
            <button
              className="prism-btn inline-flex shrink-0 items-center gap-1.5 px-3"
              type="button"
              onClick={onPickFolder}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              Browse
            </button>
          </div>
        </div>

        <div className="grid gap-1.5">
          <label className="grid gap-1.5">
            <span className="prism-label">Sync API token</span>
            <input
              className="prism-input disabled:opacity-50"
              type="password"
              value={form.token}
              disabled={form.clearToken}
              onChange={(event) => onChange({ token: event.target.value })}
              placeholder={tokenPlaceholder}
            />
          </label>
          {tokenHint ? <p className="text-xs text-zinc-500">{tokenHint}</p> : null}
          {hasSavedToken ? (
            <label className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <input
                type="checkbox"
                className="accent-violet-500"
                checked={form.clearToken}
                onChange={(event) => onChange({ clearToken: event.target.checked, token: "" })}
              />
              Forget the saved token
            </label>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button className="prism-btn prism-btn-primary px-4 py-2 text-sm" type="submit">
            {editingProfile ? "Save changes" : "Save profile"}
          </button>
          <button className="prism-btn px-4 py-2 text-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
