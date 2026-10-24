import { describe, expect, it } from "vitest";

import type { Job } from "../contract.js";
import { type JobContext, JobQueue, type JobSpec } from "./jobs.js";

/** A promise and the function that settles it, for jobs a test releases by hand. */
interface Gate {
  opened: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { opened, open };
}

function spec(
  label: string,
  background: boolean,
  run: (context: JobContext) => Promise<void>,
): JobSpec {
  return { type: "similar", rootId: null, planId: null, background, label, run };
}

/** Resolves once every job the queue knows has finished. */
function finished(queue: JobQueue): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => {
      if (queue.list().every((job) => job.state === "done" || job.state === "failed")) {
        resolve();
      } else {
        setTimeout(poll, 5);
      }
    };

    poll();
  });
}

describe("job queue", () => {
  it("runs queued foreground jobs before queued background jobs", async () => {
    const order: string[] = [];
    const queue = new JobQueue(() => undefined);
    const first = gate();

    queue.enqueue(
      spec("first", false, async () => {
        await first.opened;
        order.push("first");
      }),
    );
    queue.enqueue(spec("analysis", true, async () => void order.push("analysis")));
    queue.enqueue(spec("action", false, async () => void order.push("action")));

    first.open();
    await finished(queue);

    expect(order).toEqual(["first", "action", "analysis"]);
  });

  it("runs a foreground job inside a background job's checkpoint, alone", async () => {
    const order: string[] = [];
    const states: Job["state"][] = [];
    const queue = new JobQueue(() => undefined);
    const midway = gate();
    const started = gate();
    let inFlight = 0;

    const analysis = queue.enqueue(
      spec("analysis", true, async (context) => {
        order.push("analysis starts");
        started.open();
        await midway.opened;

        // Two items in flight: the checkpoint waits for both before the action runs.
        const item = async (name: string, ms: number) => {
          inFlight += 1;
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(name);
          inFlight -= 1;
        };

        const slow = item("slow item", 30);
        const fast = item("fast item", 5);

        await context.checkpoint(async () => {
          await Promise.all([slow, fast]);
        });

        order.push("analysis ends");
      }),
    );

    await started.opened;

    queue.enqueue(
      spec("action", false, async () => {
        order.push(`action (${inFlight} items in flight)`);
        states.push(queue.list().find((job) => job.id === analysis.id)?.state ?? "done");
      }),
    );

    midway.open();
    await finished(queue);

    expect(order).toEqual([
      "analysis starts",
      "fast item",
      "slow item",
      "action (0 items in flight)",
      "analysis ends",
    ]);
    // While the action runs, the analysis waits as queued rather than showing as running.
    expect(states).toEqual(["queued"]);
    expect(queue.list().map((job) => [job.label, job.state])).toEqual([
      ["analysis", "done"],
      ["action", "done"],
    ]);
  });
});
