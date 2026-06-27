import type { LockstepController } from "../hooks/useLockstepController";
import { Layout1 } from "./Layout1Sidebar";
import { Layout2 } from "./Layout2Toolbar";
import { Layout3 } from "./Layout3ThreePane";
import { Layout4 } from "./Layout4Pipeline";
import { Layout5 } from "./Layout5SingleSurface";

export function renderLayout(variant: number, ctrl: LockstepController) {
  switch (variant) {
    case 1:
      return <Layout1 ctrl={ctrl} />;
    case 2:
      return <Layout2 ctrl={ctrl} />;
    case 3:
      return <Layout3 ctrl={ctrl} />;
    case 4:
      return <Layout4 ctrl={ctrl} />;
    case 5:
      return <Layout5 ctrl={ctrl} />;
    default:
      return <Layout1 ctrl={ctrl} />;
  }
}

export { usePersistentVariant, VariantSwitcher } from "./VariantSwitcher";
