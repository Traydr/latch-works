import { ThumbnailWorkerRequestSchema } from '../../shared/contracts';
import type { ThumbnailWorkerEvent, ThumbnailWorkerResponse } from '../../shared/thumbnail';
import { ThumbnailWorkerRuntime } from './ThumbnailWorkerRuntime';

const { parentPort } = process;

if (!parentPort) {
  throw new Error('Thumbnail worker requires process.parentPort');
}

const userDataPath = process.argv[2];
const cacheRootPath = process.argv[4];

if (!userDataPath) {
  throw new Error('Thumbnail worker requires userDataPath argument');
}

const runtime = new ThumbnailWorkerRuntime({
  cacheRootPath,
  userDataPath,
  workerPath: __filename,
});

void runtime
  .init()
  .then((capabilities) => {
    const event: ThumbnailWorkerEvent = {
      type: 'worker-ready',
      capabilities,
    };
    parentPort.postMessage(event);
  })
  .catch((error) => {
    const event: ThumbnailWorkerEvent = {
      type: 'worker-ready',
      capabilities: {
        ffmpegAvailable: false,
        ffmpegExists: false,
        ffmpegPath: null,
        ffprobeAvailable: false,
        ffprobeExists: false,
        ffprobePath: null,
        probeErrors: [
          error instanceof Error ? error.message : 'Thumbnail worker failed to initialize',
        ],
        sharpAvailable: false,
        workerPath: __filename,
      },
    };
    parentPort.postMessage(event);
  });

parentPort.on('message', (message) => {
  const parsedRequest = ThumbnailWorkerRequestSchema.safeParse(message.data);
  if (!parsedRequest.success) {
    return;
  }

  const request = parsedRequest.data;

  void runtime
    .handleRequest(request)
    .then((response) => {
      if (!response) {
        return;
      }

      parentPort.postMessage(response satisfies ThumbnailWorkerResponse);
    })
    .catch((error) => {
      const response: ThumbnailWorkerResponse = {
        requestId: request.requestId,
        ok: false,
        error:
          error instanceof Error ? error.message : 'Thumbnail worker request failed unexpectedly',
      };

      parentPort.postMessage(response);
    });
});
