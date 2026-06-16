import { redirect } from "@tanstack/react-router";
import { isCurrentWebSessionValid } from "@/server/auth/web-session";

export async function requireCurrentWebSession(): Promise<void> {
  if (!(await isCurrentWebSessionValid())) {
    throw redirect({ to: "/login" });
  }
}
