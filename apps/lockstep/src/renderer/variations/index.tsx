import type { LockstepController } from "../hooks/useLockstepController";
import { Layout1 } from "./Layout1CompactBar";
import { Layout2 } from "./Layout2SplitRail";
import { Layout3 } from "./Layout3BottomCommand";
import { Layout4 } from "./Layout4HeaderPipeline";
import { Layout5 } from "./Layout5CenteredFlow";

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
