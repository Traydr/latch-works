export interface AvifWorkerRequest {
  id: number;
  blob: Blob;
}

export type AvifWorkerResponse =
  | { id: number; ok: true; buffer: ArrayBuffer }
  | { id: number; ok: false; encoderFailed: boolean; message: string };
