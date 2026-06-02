import type { CatalogWorkerRequest, CatalogWorkerResponse } from '../../shared/catalog';
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
  const request = message.data as CatalogWorkerRequest;

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
