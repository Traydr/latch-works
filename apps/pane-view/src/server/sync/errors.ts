/* The ways a sync request can be refused; `route.ts` gives each its HTTP status. */

export class SyncRunNotFoundError extends Error {
  constructor() {
    super("Sync run not found.");
    this.name = "SyncRunNotFoundError";
  }
}

/** The run's state refuses the request: it has finished, or finished differently. */
export class SyncRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRunConflictError";
  }
}

/** The object in storage is missing or differs from the upload the client declared. */
export class UploadMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadMismatchError";
  }
}
