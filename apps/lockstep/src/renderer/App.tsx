import { AppLayout } from "./components/AppLayout";
import { useLockstepController } from "./hooks/useLockstepController";
import { useSystemTheme } from "./hooks/useSystemTheme";

export function App() {
  useSystemTheme();
  const ctrl = useLockstepController();
  return <AppLayout ctrl={ctrl} />;
}
