import type { LockstepProfilePublic } from "../../shared/types";

export function TokenInput({
  value,
  onChange,
  profile,
}: {
  value: string;
  onChange: (value: string) => void;
  profile: LockstepProfilePublic;
}) {
  if (profile.tokenConfigured) {
    return null;
  }

  return (
    <label className="grid gap-1">
      <span className="ls-label">Sync API token</span>
      <input
        className="ls-input"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Saved with OS encryption when available"
      />
      <p className="text-[10px] text-zinc-500">
        {profile.tokenUnreadable
          ? "The saved token could not be unlocked. Enter it again to replace it."
          : "Kept in memory until quit if OS encryption is unavailable."}
      </p>
    </label>
  );
}
