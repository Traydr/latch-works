import { redirect } from "@tanstack/react-router";
import { isCurrentWebSessionValid } from "./web-session";

export async function requireWebSession(): Promise<void> {
  if (!(await isCurrentWebSessionValid())) {
    throw redirect({ to: "/login" });
  }
}
