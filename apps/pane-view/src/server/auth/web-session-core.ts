import { auth } from "./better-auth";

export async function isRequestSessionValid({
  request,
}: {
  env?: NodeJS.ProcessEnv;
  request: Request;
}): Promise<boolean> {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  return Boolean(session);
}

export async function readRequestSessionUserId({
  request,
}: {
  env?: NodeJS.ProcessEnv;
  request: Request;
}): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  return session?.user.id ?? null;
}
