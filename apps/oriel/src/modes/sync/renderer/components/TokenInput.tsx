import type { LockstepProfilePublic } from "../../shared/types";

/** The token field a profile without a saved token shows under its plan, for this session. */
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
    <label className="grid max-w-md gap-1.5">
      <span className="text-[13px] font-medium">Sync API token</span>
      <input
        className="lw-input"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Saved encrypted in ~/.latch-works"
      />
      <p className="lw-caption">
        {profile.tokenUnreadable
          ? "The saved token could not be unlocked. Enter it again to replace it."
          : "Encrypted with a key kept in ~/.latch-works/lockstep."}
      </p>
    </label>
  );
}
