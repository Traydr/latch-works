import { useEffect, useState } from "react";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** True on touch-first devices, where taps replace hover and the mouse cursor. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
