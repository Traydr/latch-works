import type { JSX } from 'react';

interface SettingsToggleRowProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function SettingsToggleRow({
  checked,
  label,
  onChange,
}: SettingsToggleRowProps): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <input
        type="checkbox"
        className="h-4 w-4 accent-violet-500"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
