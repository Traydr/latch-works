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
        placeholder="Saved encrypted in ~/.latch-works"
      />
      <p className="text-[10px] text-zinc-500">
        {profile.tokenUnreadable
          ? "The saved token could not be unlocked. Enter it again to replace it."
          : "Encrypted with a key kept in ~/.latch-works/lockstep."}
      </p>
    </label>
  );
}
