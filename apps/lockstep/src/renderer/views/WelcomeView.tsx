import { FolderSync } from "lucide-react";

interface WelcomeViewProps {
  onCreateProfile: () => void;
}

export function WelcomeView({ onCreateProfile }: WelcomeViewProps) {
  return (
    <section className="prism-section flex flex-col items-start gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-violet-300/70 bg-violet-100/70 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200">
          <FolderSync className="size-5" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Welcome to Lockstep</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Connect a local archive folder to your private Pane View instance.
          </p>
        </div>
      </div>
      <p className="max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        Create a profile with your source folder, API URL, and sync token. Lockstep plans changes,
        pushes uploads and updates separately, and only applies remote deletes when you confirm.
      </p>
      <button
        className="prism-btn prism-btn-primary px-4 py-2 text-sm"
        type="button"
        onClick={onCreateProfile}
      >
        Create your first profile
      </button>
    </section>
  );
}
