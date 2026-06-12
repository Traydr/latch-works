import { FolderOpen } from "lucide-react";

interface ProfileFormState {
  apiUrl: string;
  name: string;
  sourceRoot: string;
  token: string;
}

interface ProfileSetupViewProps {
  form: ProfileFormState;
  onCancel: () => void;
  onChange: (patch: Partial<ProfileFormState>) => void;
  onPickFolder: () => void;
  onSubmit: (event: React.FormEvent) => void;
}

export function ProfileSetupView({
  form,
  onCancel,
  onChange,
  onPickFolder,
  onSubmit,
}: ProfileSetupViewProps) {
  return (
    <section className="prism-section">
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Profile setup</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Named profiles let you switch between local and production targets.
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

        <label className="grid gap-1.5">
          <span className="prism-label">Source folder</span>
          <div className="flex gap-2">
            <input
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
        </label>

        <label className="grid gap-1.5">
          <span className="prism-label">Sync API token</span>
          <input
            className="prism-input"
            type="password"
            value={form.token}
            onChange={(event) => onChange({ token: event.target.value })}
            placeholder="Saved with OS encryption when available"
          />
        </label>

        <div className="flex flex-wrap gap-2 pt-1">
          <button className="prism-btn prism-btn-primary px-4 py-2 text-sm" type="submit">
            Save profile
          </button>
          <button className="prism-btn px-4 py-2 text-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
