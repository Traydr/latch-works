import { formatError, toError } from "../gather/errors";
import {
  endDeletedProfileJobs,
  getGatherQueueDisplayRun,
  getNextQueuedGatherJob,
  getPermissionRequiredGatherJob,
  getRetryableGatherQueueResult,
  MAX_GATHER_QUEUE_LENGTH,
  PROFILE_DELETED_MESSAGE,
  recordGatherQueueResult,
  recordHandedBackFile,
  recoverStoppedGatherQueue,
  withdrawGatherQueueResult,
  type CollectingGatherQueueJob,
  type GatherQueueState,
  type OutputGatherQueueJob
} from "../shared/gather-queue";
import {
  isTerminalGatherRunEvent,
  type GatherRunCancelOutcome,
  type GatherRunEvent,
  type GatherRunEventMessage
} from "../shared/gather-run-messages";
import {
  createGatherRunState,
  isTerminalGatherRunPhase,
  type GatherRunStartOutcome,
  type GatherRunState
} from "../shared/gather-run";
import { groupXPostInFolder } from "../shared/path";
import { getDistinguishingProfileName } from "../shared/profiles";
import { getSiteKeyFromUrl, isSupportedUrl, type SiteKey } from "../shared/sites";
import type { DownloadablePayload } from "../shared/types";
import { applyGatherRunEvent, type HandedBackFile } from "../shared/gather-run-reducer";
import {
  createChromeCoordinatorDependencies,
  type GatherRunCoordinatorDependencies
} from "./gather-run-coordinator-dependencies";

export { applyGatherRunEvent } from "../shared/gather-run-reducer";

export type { GatherRunCoordinatorDependencies } from "./gather-run-coordinator-dependencies";

const REQUESTED_PROFILE_DELETED_MESSAGE =
  "That profile was deleted. Check the folder for the profile shown and try again.";

type Reservation =
  | { kind: "collect"; run: CollectingGatherQueueJob["run"]; position: number }
  | { kind: "existing"; runId: string; position: number }
  | { kind: "outcome"; outcome: GatherRunStartOutcome };

interface ReservationResult {
  reservation: Reservation;
  /** A paused job was unblocked by this intent and needs dispatching before the new page. */
  resumed: boolean;
}

export class GatherRunCoordinator {
  private operationQueue = Promise.resolve();

  constructor(
    private readonly dependencies: GatherRunCoordinatorDependencies =
      createChromeCoordinatorDependencies()
  ) {}

  /** `requestedProfileId` is the profile whose folder the side panel confirmed, if it sent one. */
  async startForTab(
    tab: chrome.tabs.Tab,
    requestedProfileId?: string
  ): Promise<GatherRunStartOutcome> {
    if (tab.id === undefined || tab.windowId === undefined || !tab.url) {
      return { outcome: "target-unavailable" };
    }

    if (!isSupportedUrl(tab.url)) {
      return { outcome: "unsupported-source" };
    }

    const siteKey = getSiteKeyFromUrl(tab.url);

    if (!siteKey) {
      return { outcome: "unsupported-source" };
    }

    // The page keeps the profile it was gathered under, even if another one is chosen while it is
    // collected.
    const profileId = await this.resolveProfileId(requestedProfileId);

    if (!profileId) {
      return { outcome: "failed", message: REQUESTED_PROFILE_DELETED_MESSAGE };
    }

    const { reservation, resumed } = await this.reserve(tab, siteKey, profileId);

    if (resumed || reservation.kind === "existing") {
      await this.dispatchNext();
    }

    if (reservation.kind === "outcome") {
      return reservation.outcome;
    }

    if (reservation.kind === "existing") {
      return this.outcomeForJob(reservation.runId, reservation.position);
    }

    return this.finishCollection(tab, siteKey, profileId, reservation);
  }

  async retry(runId: string, requestedProfileId?: string): Promise<GatherRunStartOutcome> {
    const previous = await this.exclusive(async () => {
      const queue = await this.dependencies.loadQueue();
      const result = getRetryableGatherQueueResult(queue);

      return result?.id === runId ? result : null;
    });

    if (!previous) {
      return { outcome: "failed", message: "No retryable Gather Run was found." };
    }

    // Retrying is the explicit way to send failed items to the folder remembered now, in the
    // profile chosen now.
    const [settings, profileId] = await Promise.all([
      this.dependencies.loadSettings(),
      this.resolveProfileId(requestedProfileId)
    ]);

    if (!profileId) {
      return { outcome: "failed", message: REQUESTED_PROFILE_DELETED_MESSAGE };
    }

    const destinationId = await this.dependencies.getDestinationId(
      previous.siteKey,
      settings.useGlobalFolder,
      profileId
    );

    const payload: DownloadablePayload = {
      ok: true,
      outputKind: "downloadable-files",
      site: previous.siteKey,
      title: "Retry",
      pageUrl: previous.tabUrl,
      galleryId: null,
      folderSegments: previous.folderSegments,
      skippedCount: 0,
      images: previous.retryImages
    };

    const reservation = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();

      if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        return null;
      }

      const run = asOutputRun({
        ...createGatherRunState({
          id: this.dependencies.randomUUID(),
          tabId: previous.tabId,
          windowId: previous.windowId,
          tabUrl: previous.tabUrl,
          siteKey: previous.siteKey,
          now: this.dependencies.now()
        }),
        phase: "queued",
        title: previous.title,
        folderSegments: payload.folderSegments,
        progress: {
          completed: 0,
          total: payload.images.length,
          saved: 0,
          skipped: 0,
          failed: 0,
          message: `Queued "${payload.title}".`
        },
        log: [{ message: `Queued retry for ${previous.retryImages.length} failed item(s).` }]
      });

      const position = queue.jobs.length;
      queue = withdrawGatherQueueResult(
        {
          ...queue,
          jobs: [...queue.jobs, { kind: "output", run, payload, settings, destinationId, profileId }]
        },
        previous
      );
      await this.dependencies.saveQueue(queue);

      return { runId: run.id, position };
    });

    if (!reservation) {
      return {
        outcome: "failed",
        message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
      };
    }

    await this.dispatchNext();

    return this.outcomeForJob(reservation.runId, reservation.position);
  }

  async cancel(runId: string): Promise<GatherRunCancelOutcome> {
    const decision = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === runId);

      if (!job) {
        return { kind: "idle" } as const;
      }

      if (
        job.kind === "output" &&
        (job.run.phase === "preparing" ||
          job.run.phase === "writing" ||
          job.run.phase === "cancelling")
      ) {
        const run = asOutputRun({
          ...job.run,
          phase: "cancelling",
          updatedAt: this.dependencies.now(),
          progress: { ...job.run.progress, message: "Cancelling Gather Run..." }
        });

        queue = replaceJob(queue, { ...job, run });
        await this.dependencies.saveQueue(queue);

        return { kind: "abort", run } as const;
      }

      const cancelled = applyGatherRunEvent(job.run, {
        kind: "cancelled",
        message: "Gather Run cancelled."
      }, this.dependencies.now());

      queue = recordAndRemove(queue, cancelled);
      await this.dependencies.saveQueue(queue);

      return { kind: "done", run: cancelled } as const;
    });

    if (decision.kind === "idle") {
      return { outcome: "idle" };
    }

    if (decision.kind === "done") {
      await this.dispatchNext();

      return { outcome: "cancelled", run: decision.run };
    }

    const aborted = await this.dependencies.abort(runId).catch(() => false);

    if (!aborted) {
      await this.handleEvent({
        type: "GATHER_BOX_RUN_EVENT",
        target: "background",
        runId,
        event: { kind: "cancelled", message: "Gather Run cancelled." }
      });
    }

    return { outcome: "cancelled", run: decision.run };
  }

  /** Records a blocked file the side panel saved for you; false when its run no longer lists it. */
  async recordHandedBackFile(file: HandedBackFile): Promise<boolean> {
    return this.exclusive(async () => {
      const queue = recordHandedBackFile(await this.dependencies.loadQueue(), file);

      if (!queue) {
        return false;
      }

      await this.dependencies.saveQueue(queue);

      return true;
    });
  }

  async handleEvent(message: GatherRunEventMessage): Promise<void> {
    const profiles =
      message.event.kind === "permission-required" ? await this.dependencies.loadProfiles() : null;

    const shouldDispatch = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === message.runId);

      if (!job) {
        // A redelivered terminal report: the run is already recorded, but the dispatch that
        // should have followed it may have failed, which is why the executor is retrying.
        return isTerminalGatherRunEvent(message.event);
      }

      if (job.kind !== "output") {
        return false;
      }

      if (job.run.phase === "cancelling" && message.event.kind !== "cancelled") {
        return false;
      }

      // A paused report is redelivered until acknowledged. One that lands after the job was
      // resumed or restarted is stale, and pausing the job again would stall real work.
      if (message.event.kind === "permission-required" && job.run.phase !== "preparing") {
        return false;
      }

      // Only a gather under the paused job's own profile can confirm its folder, so name that
      // profile whenever there is more than one to choose from.
      const profileName = profiles ? getDistinguishingProfileName(profiles, job.profileId) : null;

      // A job that was starting when its profile was deleted cannot pause: no gather can confirm
      // a folder for a profile that no longer exists, so the pause would hold up the queue.
      const profileDeleted =
        profiles !== null && !profiles.profiles.some((profile) => profile.id === job.profileId);

      const event: GatherRunEvent = profileDeleted
        ? { kind: "failed", message: PROFILE_DELETED_MESSAGE }
        : message.event.kind === "permission-required" && profileName
          ? { ...message.event, profileName }
          : message.event;

      const updated = applyGatherRunEvent(job.run, event, this.dependencies.now());

      if (isTerminalGatherRunPhase(updated.phase)) {
        queue = recordAndRemove(queue, updated);
        await this.dependencies.saveQueue(queue);

        return true;
      }

      queue = replaceJob(queue, { ...job, run: asOutputRun(updated) });
      await this.dependencies.saveQueue(queue);

      return false;
    });

    if (shouldDispatch) {
      await this.dispatchNext();
    }
  }

  /** Ends outputs still waiting on a profile that no longer exists, then moves the queue on. */
  async failDeletedProfileJobs(): Promise<void> {
    const ended = await this.exclusive(async () => {
      const [loaded, profiles] = await Promise.all([
        this.dependencies.loadQueue(),
        this.dependencies.loadProfiles()
      ]);

      const profileIds = new Set(profiles.profiles.map((profile) => profile.id));
      const result = endDeletedProfileJobs(loaded, profileIds, this.dependencies.now());

      if (result.ended.length > 0) {
        const queue = result.ended.reduce(recordGatherQueueResult, result.queue);
        await this.dependencies.saveQueue(queue);
      }

      return result.ended.length;
    });

    if (ended > 0) {
      await this.dispatchNext();
    }
  }

  async recover(): Promise<void> {
    const activeRunId = await this.dependencies.getActiveRunId();
    await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();

      if (activeRunId && queue.jobs.some((job) => job.run.id === activeRunId)) {
        return;
      }

      const recovered = recoverStoppedGatherQueue(queue, this.dependencies.now());
      queue = recovered.ended.reduce(recordGatherQueueResult, recovered.queue);
      await this.dependencies.saveQueue(queue);
    });
    await this.failDeletedProfileJobs();
    await this.dispatchNext();
  }

  private async reserve(
    tab: chrome.tabs.Tab,
    siteKey: SiteKey,
    profileId: string
  ): Promise<ReservationResult> {
    return this.exclusive(async () => {
      const loaded = await this.dependencies.loadQueue();
      // Confirming folder access unblocks a paused job, but it is not a request to gather that
      // job's page again. The tab in hand still gets collected on its own.
      const permissionJob = getPermissionRequiredGatherJob(loaded, siteKey, profileId);

      let queue = permissionJob
        ? replaceJob(loaded, resumePermissionJob(permissionJob, this.dependencies.now()))
        : loaded;

      const resumed = permissionJob !== null;
      let reservation: Reservation;

      const duplicate = queue.jobs.find((job) => job.run.tabUrl === tab.url);

      if (duplicate) {
        reservation = {
          kind: "existing",
          runId: duplicate.run.id,
          position: queue.jobs.indexOf(duplicate)
        };
      } else if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        reservation = {
          kind: "outcome",
          outcome: {
            outcome: "failed",
            message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
          }
        };
      } else {
        const run = asCollectingRun({
          ...createGatherRunState({
            id: this.dependencies.randomUUID(),
            tabId: tab.id!,
            windowId: tab.windowId!,
            tabUrl: tab.url!,
            siteKey,
            now: this.dependencies.now()
          }),
          phase: "collecting",
          log: [{ message: "Collecting content metadata..." }],
          progress: {
            completed: 0,
            total: 0,
            saved: 0,
            skipped: 0,
            failed: 0,
            message: "Collecting content metadata..."
          }
        });

        reservation = { kind: "collect", run, position: queue.jobs.length };
        queue = { ...queue, jobs: [...queue.jobs, { kind: "collecting", run }] };
      }

      if (queue !== loaded) {
        await this.dependencies.saveQueue(queue);
      }

      return { reservation, resumed };
    });
  }

  private async finishCollection(
    tab: chrome.tabs.Tab,
    siteKey: SiteKey,
    profileId: string,
    reservation: Extract<Reservation, { kind: "collect" }>
  ): Promise<GatherRunStartOutcome> {
    try {
      const currentTab = await this.dependencies.getTab(tab.id!);

      if (
        !currentTab.url ||
        currentTab.url !== reservation.run.tabUrl ||
        getSiteKeyFromUrl(currentTab.url) !== siteKey
      ) {
        throw new Error("The source tab navigated before collection started.");
      }

      const [collected, settings] = await Promise.all([
        this.dependencies.collect(currentTab, reservation.run),
        this.dependencies.loadSettings()
      ]);

      // Pin the folder remembered when the page was gathered, so choosing another one later
      // cannot silently redirect this output.
      const destinationId = await this.dependencies.getDestinationId(
        siteKey,
        settings.useGlobalFolder,
        profileId
      );

      const payload =
        settings.xPostFolders && collected.outputKind === "downloadable-files"
          ? groupXPostInFolder(collected)
          : collected;

      const total =
        payload.outputKind === "generated-story-pdf"
          ? payload.chapters.length
          : payload.images.length;

      const completed = await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        const index = queue.jobs.findIndex((job) => job.run.id === reservation.run.id);

        if (index < 0 || queue.jobs[index].kind !== "collecting") {
          return false;
        }

        // Checked under the same lock as failDeletedProfileJobs, so a profile deleted during
        // collection either ends this output there or is seen deleted here.
        const profiles = await this.dependencies.loadProfiles();

        if (!profiles.profiles.some((profile) => profile.id === profileId)) {
          throw new Error(PROFILE_DELETED_MESSAGE);
        }

        const run = asOutputRun({
          ...reservation.run,
          phase: "queued",
          updatedAt: this.dependencies.now(),
          title: payload.title,
          folderSegments: payload.folderSegments,
          progress: { ...reservation.run.progress, total, message: `Queued "${payload.title}".` },
          log: [
            ...reservation.run.log,
            { message: `Queued ${total} item(s) from "${payload.title}".`, tone: "success" }
          ]
        });

        const jobs = [...queue.jobs];
        jobs[index] = { kind: "output", run, payload, settings, destinationId, profileId };
        queue = { ...queue, jobs };
        await this.dependencies.saveQueue(queue);

        return true;
      });

      if (!completed) {
        return { outcome: "failed", message: "The queued Gather Run was cancelled." };
      }

      await this.dispatchNext();

      return this.outcomeForJob(reservation.run.id, reservation.position);
    } catch (error) {
      const failed = applyGatherRunEvent(
        reservation.run,
        { kind: "failed", message: formatError(toError(error)) },
        this.dependencies.now()
      );

      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();

        if (!queue.jobs.some((job) => job.run.id === reservation.run.id)) {
          return;
        }

        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
      await this.dispatchNext();

      return { outcome: "failed", message: failed.error ?? "Gather Run failed." };
    }
  }

  private async dispatchNext(): Promise<void> {
    while (true) {
      const job = await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        const next = getNextQueuedGatherJob(queue);

        if (!next) {
          return null;
        }

        const run = asOutputRun({
          ...next.run,
          phase: "preparing",
          updatedAt: this.dependencies.now(),
          progress: {
            ...next.run.progress,
            completed: 0,
            message: "Starting queued Gather Output..."
          }
        });

        const claimed = { ...next, run };
        queue = replaceJob(queue, claimed);
        await this.dependencies.saveQueue(queue);

        return claimed;
      });

      if (!job) {
        return;
      }

      const accepted = await this.dependencies.execute(job).catch(() => false);

      if (accepted) {
        return;
      }

      const failed = applyGatherRunEvent(
        job.run,
        { kind: "failed", message: "The Gather executor did not accept the queued output." },
        this.dependencies.now()
      );

      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();

        if (!queue.jobs.some((candidate) => candidate.run.id === job.run.id)) {
          return;
        }

        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
    }
  }

  private async outcomeForJob(
    runId: string,
    requestedPosition: number
  ): Promise<GatherRunStartOutcome> {
    const queue = await this.exclusive(() => this.dependencies.loadQueue());
    const job = queue.jobs.find((candidate) => candidate.run.id === runId);
    const completed = queue.results.find((result) => result.id === runId);

    if (!job && !completed) {
      return { outcome: "failed", message: "The queued Gather Run could not be restored." };
    }

    const run = getGatherQueueDisplayRun(queue) ?? completed ?? job!.run;

    if (job?.kind === "output" && job.run.phase !== "queued") {
      return { outcome: "started", run, queuedRunId: runId, position: 0 };
    }

    return {
      outcome: "queued",
      run,
      queuedRunId: runId,
      position: Math.max(1, requestedPosition)
    };
  }

  /**
   * The requested profile when it still exists, the active one when none was requested, and null
   * when the requested one was deleted: writing to another profile's folder would surprise.
   */
  private async resolveProfileId(requestedProfileId?: string): Promise<string | null> {
    const profiles = await this.dependencies.loadProfiles();

    if (requestedProfileId === undefined) {
      return profiles.activeProfileId;
    }

    return profiles.profiles.some((profile) => profile.id === requestedProfileId)
      ? requestedProfileId
      : null;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}

function resumePermissionJob(job: OutputGatherQueueJob, now: number): OutputGatherQueueJob {
  return {
    ...job,
    run: asOutputRun({
      ...job.run,
      phase: "queued",
      error: null,
      updatedAt: now,
      progress: { ...job.run.progress, message: "Folder access confirmed. Queued." }
    })
  };
}

function replaceJob(queue: GatherQueueState, job: OutputGatherQueueJob): GatherQueueState {
  return {
    ...queue,
    jobs: queue.jobs.map((candidate) => (candidate.run.id === job.run.id ? job : candidate))
  };
}

function recordAndRemove(queue: GatherQueueState, run: GatherRunState): GatherQueueState {
  return recordGatherQueueResult(
    { ...queue, jobs: queue.jobs.filter((job) => job.run.id !== run.id) },
    run
  );
}

function asCollectingRun(run: GatherRunState): CollectingGatherQueueJob["run"] {
  if (run.phase !== "collecting") {
    throw new Error(`Expected collecting Gather Run, received ${run.phase}.`);
  }

  return { ...run, phase: run.phase };
}

function asOutputRun(run: GatherRunState): OutputGatherQueueJob["run"] {
  if (isTerminalGatherRunPhase(run.phase) || run.phase === "collecting") {
    throw new Error(`Expected executable Gather Run, received ${run.phase}.`);
  }

  return { ...run, phase: run.phase };
}
