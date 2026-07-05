import { beforeEach, describe, expect, it, vi } from "vitest";

function createSelectChain(resolvedValue: unknown) {
  const limitMock = vi.fn().mockResolvedValue(resolvedValue);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  return { fromMock, limitMock, selectMock, whereMock };
}

function createInsertChain() {
  const valuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { insertMock, valuesMock };
}

function createUpdateChain(returningValue?: unknown) {
  if (returningValue !== undefined) {
    const returningMock = vi.fn().mockResolvedValue(returningValue);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    return { returningMock, setMock, updateMock, whereMock };
  }

  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });
  return { setMock, updateMock, whereMock };
}

const validSha256 = "a".repeat(64);

const thumbnailContext = {
  extension: "jpg",
  mediaObjectId: "obj-1",
  mediaType: "image" as const,
  originalObjectKey: "objects/abc",
  sha256: validSha256,
};

const readyRow = {
  error: null,
  height: 120,
  mediaObjectId: "obj-1",
  objectKey: "thumbnails/abc/320.webp",
  size: 320,
  status: "ready" as const,
  updatedAt: new Date("2026-06-12T12:00:00.000Z"),
  width: 160,
};

const generatedDerivative = { bytes: Buffer.from("webp"), height: 120, width: 160 };

const mocks = vi.hoisted(() => ({
  deleteStoredObject: vi.fn(),
  generateDerivativeBytes: vi.fn(),
  headStoredObject: vi.fn(),
  insertMock: vi.fn(),
  putStoredObject: vi.fn(),
  readMediaThumbnailContext: vi.fn(),
  readStoredObjectBytes: vi.fn(),
  readWebpMetadata: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    insert: mocks.insertMock,
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
}));

vi.mock("./repository", () => ({
  readMediaThumbnailContext: mocks.readMediaThumbnailContext,
}));

vi.mock("./storage-client", () => ({
  createPaneViewStorageClient: vi.fn(() => ({})),
}));

vi.mock("@latch-works/media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@latch-works/media-storage")>();
  return {
    ...actual,
    deleteStoredObject: mocks.deleteStoredObject,
    headStoredObject: mocks.headStoredObject,
    putStoredObject: mocks.putStoredObject,
    readStoredObjectBytes: mocks.readStoredObjectBytes,
  };
});

// The CPU-heavy generation package is loaded via dynamic import; mock it so
// these tests exercise only the Pane View DB orchestration / state machine.
vi.mock("@latch-works/media-derivatives", () => ({
  generateDerivativeBytes: mocks.generateDerivativeBytes,
  readWebpMetadata: mocks.readWebpMetadata,
}));

import { ensureThumbnailDerivative } from "./derivative-service";

describe("ensureThumbnailDerivative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readMediaThumbnailContext.mockResolvedValue(thumbnailContext);
    mocks.headStoredObject.mockResolvedValue(null);
    mocks.generateDerivativeBytes.mockResolvedValue(generatedDerivative);
    mocks.putStoredObject.mockResolvedValue(undefined);
  });

  it("inserts pending, claims, and delegates generation when no row exists", async () => {
    const select = createSelectChain([]);
    const insert = createInsertChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.insertMock.mockReturnValue({ values: insert.valuesMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(insert.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaObjectId: "obj-1", size: 320, status: "pending" }),
    );
    expect(claim.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", updatedAt: expect.any(Date) }),
    );
    expect(mocks.generateDerivativeBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 320,
        source: expect.objectContaining({ mediaType: "image", originalObjectKey: "objects/abc" }),
      }),
    );
    expect(mocks.putStoredObject).toHaveBeenCalledWith(
      expect.objectContaining({ body: generatedDerivative.bytes, contentType: "image/webp" }),
    );
    expect(result).toEqual(expect.objectContaining({ height: 120, status: "ready", width: 160 }));
  });

  it("claims an existing pending row and delegates generation", async () => {
    const pendingRow = { ...readyRow, height: 0, status: "pending" as const, width: 0 };
    const select = createSelectChain([pendingRow]);
    const promote = createUpdateChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: promote.setMock })
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(promote.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queuePriority: 200,
        queueSource: "on-demand",
        queueVariant: "thumbnail",
      }),
    );
    expect(mocks.generateDerivativeBytes).toHaveBeenCalled();
    expect(result.status).toBe("ready");
  });

  it("returns pending when an existing pending row cannot be claimed", async () => {
    const pendingRow = { ...readyRow, height: 0, status: "pending" as const, width: 0 };
    const select = createSelectChain([pendingRow]);
    const promote = createUpdateChain();
    const claim = createUpdateChain([]);

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: promote.setMock })
      .mockReturnValueOnce({ set: claim.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(result).toEqual({ status: "pending" });
    expect(mocks.generateDerivativeBytes).not.toHaveBeenCalled();
  });

  it("returns pending for an unexpired processing lease without claiming", async () => {
    const updatedAt = new Date("2026-06-12T12:00:00.000Z");
    const processingRow = {
      ...readyRow,
      height: 0,
      status: "processing" as const,
      updatedAt,
      width: 0,
    };
    const select = createSelectChain([processingRow]);

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    vi.spyOn(Date, "now").mockReturnValue(updatedAt.getTime() + 60_000);

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(result).toEqual({ status: "pending" });
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.generateDerivativeBytes).not.toHaveBeenCalled();

    vi.spyOn(Date, "now").mockRestore();
  });

  it("resets an expired processing lease, claims, and delegates generation", async () => {
    const updatedAt = new Date("2026-06-12T12:00:00.000Z");
    const processingRow = {
      ...readyRow,
      height: 0,
      status: "processing" as const,
      updatedAt,
      width: 0,
    };
    const select = createSelectChain([processingRow]);
    const reset = createUpdateChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: reset.setMock })
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });

    vi.spyOn(Date, "now").mockReturnValue(updatedAt.getTime() + 11 * 60 * 1000);

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(reset.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: null, status: "pending", updatedAt: expect.any(Date) }),
    );
    expect(claim.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", updatedAt: expect.any(Date) }),
    );
    expect(mocks.generateDerivativeBytes).toHaveBeenCalled();
    expect(result.status).toBe("ready");

    vi.spyOn(Date, "now").mockRestore();
  });

  it("returns ready for an existing ready row without writing", async () => {
    const select = createSelectChain([readyRow]);

    mocks.selectMock.mockReturnValue({ from: select.fromMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(result).toEqual({
      height: 120,
      objectKey: "thumbnails/abc/320.webp",
      purpose: "thumbnail",
      status: "ready",
      width: 160,
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.generateDerivativeBytes).not.toHaveBeenCalled();
  });

  it("adopts an already-stored derivative object without regenerating", async () => {
    const select = createSelectChain([]);
    const insert = createInsertChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.insertMock.mockReturnValue({ values: insert.valuesMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });
    mocks.headStoredObject.mockResolvedValue({
      contentLength: 1024,
      contentType: "image/webp",
      etag: '"etag"',
    });
    mocks.readStoredObjectBytes.mockResolvedValue(Buffer.from("stored-webp"));
    mocks.readWebpMetadata.mockResolvedValue({ height: 200, width: 240 });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(mocks.generateDerivativeBytes).not.toHaveBeenCalled();
    expect(mocks.readWebpMetadata).toHaveBeenCalled();
    expect(mocks.putStoredObject).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ height: 200, status: "ready", width: 240 }));
  });

  it("marks the row failed when generation throws", async () => {
    const select = createSelectChain([]);
    const insert = createInsertChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markFailed = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.insertMock.mockReturnValue({ values: insert.valuesMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markFailed.setMock });
    mocks.generateDerivativeBytes.mockRejectedValue(new Error("boom"));

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(result).toEqual({ status: "failed" });
    expect(markFailed.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("enqueues and processes a pdf cover derivative", async () => {
    const pdfContext = {
      extension: "pdf",
      mediaObjectId: "obj-pdf",
      mediaType: "pdf" as const,
      originalObjectKey: "objects/doc.pdf",
      sha256: validSha256,
    };
    mocks.readMediaThumbnailContext.mockResolvedValue(pdfContext);

    const select = createSelectChain([]);
    const insert = createInsertChain();
    const claim = createUpdateChain([{ mediaObjectId: "obj-pdf", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.insertMock.mockReturnValue({ values: insert.valuesMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-pdf", requestedSize: 320 });

    expect(mocks.generateDerivativeBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 320,
        source: expect.objectContaining({ mediaType: "pdf", originalObjectKey: "objects/doc.pdf" }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ height: 120, status: "ready", width: 160 }));
  });
});
