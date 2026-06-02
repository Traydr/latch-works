import { readCookie, sessionCookieName } from "./session";
import { isStoredSessionValid, readStoredSessionUserId } from "./session-store";

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

export async function readRequestSessionUserId({
  env,
  request,
}: {
  env: NodeJS.ProcessEnv;
  request: Request;
}): Promise<string | null> {
  const token = readCookie(request.headers.get("Cookie"), sessionCookieName);
  return readStoredSessionUserId({ env, token });
}
