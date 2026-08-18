import { describe, expect, it, vi } from "vitest";
import { ensureDirectoryPermission, type PermissionedDirectoryHandle } from "./directory-store";

describe("directory permissions", () => {
  it("uses an already granted permission without requesting again", async () => {
    const requestPermission = vi.fn();
    const handle: PermissionedDirectoryHandle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      requestPermission
    };

    await expect(ensureDirectoryPermission(handle, false)).resolves.toBe("granted");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does not request permission during an automatic shortcut download", async () => {
    const requestPermission = vi.fn();
    const handle: PermissionedDirectoryHandle = {
      queryPermission: vi.fn().mockResolvedValue("prompt"),
      requestPermission
    };

    await expect(ensureDirectoryPermission(handle, false)).resolves.toBe(
      "requires-user-activation"
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("converts Chrome's user-activation SecurityError into an actionable result", async () => {
    const handle: PermissionedDirectoryHandle = {
      queryPermission: vi.fn().mockResolvedValue("prompt"),
      requestPermission: vi
        .fn()
        .mockRejectedValue(
          new DOMException("User activation is required to request permissions.", "SecurityError")
        )
    };

    await expect(ensureDirectoryPermission(handle, true)).resolves.toBe(
      "requires-user-activation"
    );
  });

  it("requests permission immediately for a user-initiated download", async () => {
    const queryPermission = vi.fn();
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const handle: PermissionedDirectoryHandle = { queryPermission, requestPermission };

    await expect(ensureDirectoryPermission(handle, true)).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(queryPermission).not.toHaveBeenCalled();
  });
});
