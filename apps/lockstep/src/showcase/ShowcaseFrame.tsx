import type { ReactNode } from "react";

interface ShowcaseFrameProps {
  children: ReactNode;
}

export function ShowcaseFrame({ children }: ShowcaseFrameProps) {
  return (
    <div className="showcase-recording-root">
      <div className="showcase-app-frame">{children}</div>
    </div>
  );
}
