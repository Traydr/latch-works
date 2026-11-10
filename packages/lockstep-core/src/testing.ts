/*
 * A stand-in for Pane View's sync API, for tests of the Lockstep clients. It serves on a loopback
 * port, parses every body with the sync protocol as Pane View does, and keeps what a sync leaves
 * behind: the runs and how they ended, the uploaded originals, and the library entries the
 * snapshot lists.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getExtension } from "@latch-works/media-domain";
import {
  CompleteObjectRequestSchema,
  type CompleteSyncRunRequest,
  CompleteSyncRunRequestSchema,
  type CreateSyncRunRequest,
  CreateSyncRunRequestSchema,
  completeSyncRunRoute,
  contentTypeForExtension,
  DeleteObjectRequestSchema,
  originalObjectKey,
  SYNC_ROUTES,
  UploadUrlRequestSchema,
} from "@latch-works/sync-protocol";
import { z } from "zod";

export interface FakeLibraryEntry {
  objectKey?: string;
  path: string;
  sha256?: string;
  size: number;
}

interface FakeSyncRun {
  /** How the client finalized the run; absent while it is running. */
  outcome?: CompleteSyncRunRequest;
  started: CreateSyncRunRequest;
  syncRunId: string;
}

type FakeRoute =
  | "completeObject"
  | "completeRun"
  | "createRun"
  | "delete"
  | "snapshot"
  | "upload"
  | "uploadUrl";

/** One request as the server saw it: `path` is the logical path or file name it names. */
interface FakeRequest {
  path?: string;
  route: FakeRoute;
}

/**
 * What an interceptor makes of a request: answer it with `status`, never answer it ("hold", until
 * the client gives up or the server closes), or nothing, to let the server handle it as usual.
 */
type FakeReply = { body?: string; status: number } | "hold" | undefined;

type FakeInterceptor = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakePaneView {
  apiToken: string;
  apiUrl: string;
  close(): Promise<void>;
  /** Runs before the server handles each request, in the order the requests arrive. */
  intercept(interceptor: FakeInterceptor): void;
  /** The library entries by logical path. */
  library: Map<string, FakeLibraryEntry>;
  /** The uploaded originals by object key. */
  objects: Map<string, Buffer>;
  requests: FakeRequest[];
  runs: FakeSyncRun[];
}

const TcpAddressSchema = z.object({ port: z.number() });

const JsonBodySchema = z.json();

const ActionSchema = z.object({ action: z.literal("delete") });

const UPLOAD_PREFIX = "/upload/";

/** The run a finalize URL names, or undefined for any other URL. */
function finalizedRunId(url: string): string | undefined {
  const prefix = `${SYNC_ROUTES.runs}/`;

  if (!url.startsWith(prefix)) {
    return undefined;
  }

  const [syncRunId = ""] = url.slice(prefix.length).split("/");

  return url === completeSyncRunRoute(syncRunId) ? syncRunId : undefined;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function parse<T>(schema: z.ZodType<T>, body: Buffer): T {
  const json = JsonBodySchema.safeParse(JSON.parse(body.toString("utf8")));
  const parsed = json.success ? schema.safeParse(json.data) : json;

  if (!parsed.success) {
    throw new RequestError(400, z.prettifyError(parsed.error));
  }

  return parsed.data;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Starts a fake Pane View holding `entries`; it accepts only `apiToken`. */
export async function startFakePaneView({
  apiToken = "test-token",
  entries = [],
}: {
  apiToken?: string;
  entries?: FakeLibraryEntry[];
} = {}): Promise<FakePaneView> {
  const library = new Map(entries.map((entry) => [entry.path, entry]));
  const objects = new Map<string, Buffer>();
  const runs: FakeSyncRun[] = [];
  const requests: FakeRequest[] = [];
  const interceptors: FakeInterceptor[] = [];
  let apiUrl = "";

  const runningRun = (syncRunId: string): FakeSyncRun => {
    const run = runs.find((candidate) => candidate.syncRunId === syncRunId);

    if (!run) {
      throw new RequestError(404, "Sync run not found.");
    }

    if (run.outcome) {
      throw new RequestError(409, "Sync run is not accepting writes.");
    }

    return run;
  };

  /** The request's route and what it names, read before the interceptors see it. */
  const identify = (request: IncomingMessage, body: Buffer): FakeRequest => {
    const url = request.url ?? "";

    if (url === SYNC_ROUTES.snapshot) {
      return { route: "snapshot" };
    }

    if (url === SYNC_ROUTES.runs) {
      return { route: "createRun" };
    }

    if (finalizedRunId(url) !== undefined) {
      return { route: "completeRun" };
    }

    if (url.startsWith(UPLOAD_PREFIX)) {
      return { route: "upload", path: decodeURIComponent(url.slice(UPLOAD_PREFIX.length)) };
    }

    if (url === SYNC_ROUTES.uploadUrl) {
      return { route: "uploadUrl", path: parse(UploadUrlRequestSchema, body).filename };
    }

    if (url === SYNC_ROUTES.completeObject) {
      const isDelete = ActionSchema.safeParse(JSON.parse(body.toString("utf8"))).success;

      return isDelete
        ? { route: "delete", path: parse(DeleteObjectRequestSchema, body).logicalPath }
        : { route: "completeObject", path: parse(CompleteObjectRequestSchema, body).logicalPath };
    }

    throw new RequestError(404, `No route for ${request.method} ${url}`);
  };

  const handle = (request: IncomingMessage, route: FakeRoute, body: Buffer): string => {
    switch (route) {
      case "snapshot":
        return JSON.stringify({
          entries: [...library.values()].map(({ path, sha256, size }) => ({ path, sha256, size })),
        });
      case "createRun": {
        const syncRunId = `run-${runs.length + 1}`;
        runs.push({ started: parse(CreateSyncRunRequestSchema, body), syncRunId });

        return JSON.stringify({ syncRunId });
      }

      case "completeRun": {
        const syncRunId = finalizedRunId(request.url ?? "");
        const outcome = parse(CompleteSyncRunRequestSchema, body);
        const run = runs.find((candidate) => candidate.syncRunId === syncRunId);

        if (!run) {
          throw new RequestError(404, "Sync run not found.");
        }

        // An exact replay of the recorded outcome is accepted, as Pane View accepts it.
        if (run.outcome && run.outcome.status !== outcome.status) {
          throw new RequestError(409, `Sync run is already ${run.outcome.status}.`);
        }

        run.outcome ??= outcome;

        return JSON.stringify({});
      }

      case "uploadUrl": {
        const { contentType, filename, sha256 } = parse(UploadUrlRequestSchema, body);

        if (contentType !== contentTypeForExtension(getExtension(filename))) {
          throw new RequestError(400, "contentType does not match extension");
        }

        const objectKey = originalObjectKey({ extension: getExtension(filename), sha256 });

        return JSON.stringify({
          headers: { "Content-Type": contentType },
          objectKey,
          uploadUrl: `${apiUrl}${UPLOAD_PREFIX}${encodeURIComponent(objectKey)}`,
        });
      }

      case "upload":
        objects.set(decodeURIComponent((request.url ?? "").slice(UPLOAD_PREFIX.length)), body);

        return JSON.stringify({});
      case "completeObject": {
        const registration = parse(CompleteObjectRequestSchema, body);
        runningRun(registration.syncRunId);
        const stored = objects.get(registration.objectKey);

        if (!stored) {
          throw new RequestError(400, "Uploaded object was not found in storage.");
        }

        if (
          stored.length !== registration.size ||
          sha256Of(stored) !== registration.sha256.toLowerCase()
        ) {
          throw new RequestError(400, "Uploaded object does not match its declared hash and size.");
        }

        library.set(registration.logicalPath, {
          objectKey: registration.objectKey,
          path: registration.logicalPath,
          sha256: registration.sha256,
          size: registration.size,
        });

        return JSON.stringify({});
      }

      case "delete": {
        const { logicalPath, syncRunId } = parse(DeleteObjectRequestSchema, body);
        runningRun(syncRunId);
        library.delete(logicalPath);

        return JSON.stringify({});
      }

      default: {
        const exhaustive: never = route;

        return exhaustive;
      }
    }
  };

  const respond = (response: ServerResponse, status: number, body: string) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  };

  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const seen = identify(request, body);
      requests.push(seen);

      if (seen.route !== "upload" && request.headers.authorization !== `Bearer ${apiToken}`) {
        throw new RequestError(401, "Unauthorized");
      }

      for (const interceptor of interceptors) {
        const reply = await interceptor(seen);

        if (reply === "hold") {
          return;
        }

        if (reply) {
          respond(response, reply.status, reply.body ?? "{}");

          return;
        }
      }

      respond(response, 200, handle(request, seen.route, body));
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      respond(response, status, JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${TcpAddressSchema.parse(server.address()).port}`;

  return {
    apiToken,
    apiUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    intercept: (interceptor) => {
      interceptors.push(interceptor);
    },
    library,
    objects,
    requests,
    runs,
  };
}
