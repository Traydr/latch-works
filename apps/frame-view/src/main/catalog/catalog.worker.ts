import type { CatalogWorkerResponse } from '../../shared/catalog';
import { CatalogWorkerRequestSchema } from '../../shared/contracts';
import { CatalogRuntime } from './CatalogRuntime';

const { parentPort } = process;

if (!parentPort) {
  throw new Error('Catalog worker requires process.parentPort');
}

const userDataPath = process.argv[2];

if (!userDataPath) {
  throw new Error('Catalog worker requires userDataPath argument');
}

const runtime = new CatalogRuntime({
  userDataPath,
  emitEvent: (event) => {
    parentPort.postMessage(event);
  },
  emitResponse: (response) => {
    parentPort.postMessage(response);
  },
});

parentPort.on('message', (message) => {
  const parsedRequest = CatalogWorkerRequestSchema.safeParse(message.data);
  if (!parsedRequest.success) {
    return;
  }

  const request = parsedRequest.data;

  void runtime.handleRequest(request).catch((error) => {
    const response: CatalogWorkerResponse = {
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Catalog worker request failed unexpectedly',
    };

    parentPort.postMessage(response);
  });
});

process.once('beforeExit', () => {
  void runtime.shutdown();
});
