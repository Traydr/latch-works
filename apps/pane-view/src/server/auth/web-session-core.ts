import { readCookie, sessionCookieName } from "./session";
import { isStoredSessionValid } from "./session-store";

export async function isRequestSessionValid({
  env,
  request,
}: {
  env: NodeJS.ProcessEnv;
  request: Request;
}): Promise<boolean> {
  const token = readCookie(request.headers.get("Cookie"), sessionCookieName);
  return isStoredSessionValid({ env, token });
}
