import { encodeAvifImageData } from "./avif-codec";
import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-worker-messages";

self.addEventListener("message", (event: MessageEvent<AvifWorkerRequest>) => {
  void encodeRequest(event.data);
});

async function encodeRequest(request: AvifWorkerRequest): Promise<void> {
  try {
    const imageData = await decodeStillImage(request.blob);
    const buffer = await encodeAvifImageData(imageData);
    const response: AvifWorkerResponse = { id: request.id, ok: true, buffer };
    self.postMessage(response, { transfer: [buffer] });
  } catch (error) {
    const response: AvifWorkerResponse = {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : "AVIF conversion failed."
    };
    self.postMessage(response);
  }
}

async function decodeStillImage(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not create an image conversion canvas.");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
