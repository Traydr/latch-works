import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";

interface GalleryShellContextValue {
  requestOpenSettings: () => void;
  setOpenSettingsHandler: (handler: (() => void) | null) => void;
}

const GalleryShellContext = createContext<GalleryShellContextValue | null>(null);

export function GalleryShellProvider({ children }: Readonly<{ children: ReactNode }>) {
  const handlerRef = useRef<(() => void) | null>(null);
  const requestOpenSettings = useCallback(() => {
    handlerRef.current?.();
  }, []);
  const setOpenSettingsHandler = useCallback((handler: (() => void) | null) => {
    handlerRef.current = handler;
  }, []);
  const value = useMemo(
    () => ({ requestOpenSettings, setOpenSettingsHandler }),
    [requestOpenSettings, setOpenSettingsHandler],
  );

  return <GalleryShellContext.Provider value={value}>{children}</GalleryShellContext.Provider>;
}

export function useGalleryShell(): GalleryShellContextValue {
  const value = useContext(GalleryShellContext);
  if (!value) {
    throw new Error("useGalleryShell must be used within GalleryShellProvider");
  }

  return value;
}
