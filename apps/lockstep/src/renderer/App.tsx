import { useLockstepController } from "./hooks/useLockstepController";
import { useSystemTheme } from "./hooks/useSystemTheme";
import { renderLayout, usePersistentVariant, VariantSwitcher } from "./variations";

export function App() {
  useSystemTheme();
  const ctrl = useLockstepController();
  const [variant, setVariant] = usePersistentVariant();

  return (
    <>
      {renderLayout(variant, ctrl)}
      <VariantSwitcher ctrl={ctrl} variant={variant} onChange={setVariant} />
    </>
  );
}
