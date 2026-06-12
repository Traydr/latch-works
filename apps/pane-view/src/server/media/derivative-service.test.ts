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

const mocks = vi.hoisted(() => ({
  headStoredObject: vi.fn(),
  insertMock: vi.fn(),
  putStoredObject: vi.fn(),
  readMediaThumbnailContext: vi.fn(),
  readStoredObjectBytes: vi.fn(),
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
    headStoredObject: mocks.headStoredObject,
    putStoredObject: mocks.putStoredObject,
    readStoredObjectBytes: mocks.readStoredObjectBytes,
  };
});

vi.mock("sharp", () => {
  const sharpFn = vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ height: 120, width: 160 }),
    resize: vi.fn().mockReturnThis(),
    rotate: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from("webp"),
      info: { height: 120, width: 160 },
    }),
    webp: vi.fn().mockReturnThis(),
  }));

  return { default: sharpFn };
});

import { ensureThumbnailDerivative } from "./derivative-service";

describe("ensureThumbnailDerivative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readMediaThumbnailContext.mockResolvedValue(thumbnailContext);
    mocks.headStoredObject.mockResolvedValue(null);
    mocks.readStoredObjectBytes.mockResolvedValue(Buffer.from("source-image"));
    mocks.putStoredObject.mockResolvedValue(undefined);
  });

  it("inserts pending, claims, and attempts generation when no row exists", async () => {
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
    expect(mocks.headStoredObject).toHaveBeenCalled();
    expect(mocks.readStoredObjectBytes).toHaveBeenCalled();
    expect(mocks.putStoredObject).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        height: 120,
        status: "ready",
        width: 160,
      }),
    );
  });

  it("claims an existing pending row and attempts generation", async () => {
    const pendingRow = {
      ...readyRow,
      height: 0,
      status: "pending" as const,
      width: 0,
    };
    const select = createSelectChain([pendingRow]);
    const claim = createUpdateChain([{ mediaObjectId: "obj-1", size: 320, status: "processing" }]);
    const markReady = createUpdateChain();

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.updateMock
      .mockReturnValueOnce({ set: claim.setMock })
      .mockReturnValueOnce({ set: markReady.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(claim.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", updatedAt: expect.any(Date) }),
    );
    expect(mocks.headStoredObject).toHaveBeenCalled();
    expect(result.status).toBe("ready");
  });

  it("returns pending when an existing pending row cannot be claimed", async () => {
    const pendingRow = {
      ...readyRow,
      height: 0,
      status: "pending" as const,
      width: 0,
    };
    const select = createSelectChain([pendingRow]);
    const claim = createUpdateChain([]);

    mocks.selectMock.mockReturnValue({ from: select.fromMock });
    mocks.updateMock.mockReturnValue({ set: claim.setMock });

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(result).toEqual({ status: "pending" });
    expect(mocks.headStoredObject).not.toHaveBeenCalled();
    expect(mocks.readStoredObjectBytes).not.toHaveBeenCalled();
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
    expect(mocks.headStoredObject).not.toHaveBeenCalled();

    vi.spyOn(Date, "now").mockRestore();
  });

  it("resets an expired processing lease, claims, and attempts generation", async () => {
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

    const now = updatedAt.getTime() + 11 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const result = await ensureThumbnailDerivative({ mediaId: "media-1", requestedSize: 320 });

    expect(reset.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: null, status: "pending", updatedAt: expect.any(Date) }),
    );
    expect(claim.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", updatedAt: expect.any(Date) }),
    );
    expect(mocks.headStoredObject).toHaveBeenCalled();
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
    expect(mocks.headStoredObject).not.toHaveBeenCalled();
  });
});
