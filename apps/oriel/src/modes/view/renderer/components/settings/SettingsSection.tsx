import type { JSX, PropsWithChildren } from 'react';

interface SettingsSectionProps extends PropsWithChildren {
  className?: string;
}

export function SettingsSection({ children, className }: SettingsSectionProps): JSX.Element {
  return <div className={`prism-section ${className ?? ''}`.trim()}>{children}</div>;
}
