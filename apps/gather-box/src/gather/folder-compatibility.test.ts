import { describe, expect, it, vi } from "vitest";
import { resolveCompatibleFolderSegments } from "./folder-compatibility";

describe("folder compatibility", () => {
  it("reuses an existing all-lowercase Hentai Foundry artist folder", async () => {
    const root = createDirectoryLookup({ thekite: "thekite" });

    await expect(
      resolveCompatibleFolderSegments(root.handle, "hentaifoundry-pictures", ["theKite"])
    ).resolves.toEqual({ segments: ["thekite"], usedLegacyFolder: true });
    expect(root.getDirectoryHandle).toHaveBeenCalledWith("thekite");
  });

  it("keeps the new lower-first standard when no legacy folder exists", async () => {
    const root = createDirectoryLookup({});

    await expect(
      resolveCompatibleFolderSegments(root.handle, "hentaifoundry-pictures", ["theKite"])
    ).resolves.toEqual({ segments: ["theKite"], usedLegacyFolder: false });
  });

  it("does not rename an existing standard folder on a case-insensitive filesystem", async () => {
    const root = createDirectoryLookup({ thekite: "theKite" });

    await expect(
      resolveCompatibleFolderSegments(root.handle, "hentaifoundry-pictures", ["theKite"])
    ).resolves.toEqual({ segments: ["theKite"], usedLegacyFolder: false });
  });

  it("does not apply the legacy convention to other sources", async () => {
    const root = createDirectoryLookup({ thekite: "thekite" });

    await expect(resolveCompatibleFolderSegments(root.handle, "x", ["theKite"])).resolves.toEqual({
      segments: ["theKite"],
      usedLegacyFolder: false
    });
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
  });
});

function createDirectoryLookup(entries: Record<string, string>): {
  handle: FileSystemDirectoryHandle;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
} {
  const getDirectoryHandle = vi.fn(async (name: string) => {
    const actualName = entries[name];
    if (!actualName) {
      throw new DOMException("Not found", "NotFoundError");
    }
    return { name: actualName } as FileSystemDirectoryHandle;
  });

  return {
    handle: { getDirectoryHandle } as unknown as FileSystemDirectoryHandle,
    getDirectoryHandle
  };
}
