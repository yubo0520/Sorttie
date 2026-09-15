import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord, SorttieApi } from "../shared/contracts";
import { useImageThumbnails } from "./use-image-thumbnails";

const files: FileRecord[] = Array.from({ length: 20 }, (_, index) => ({
  id: String(index), name: `${index}.png`, extension: ".png", absolutePath: `D:\\test\\${index}.png`, parentDirectory: "D:\\test",
  sizeBytes: 123, createdAt: null, modifiedAt: "2026-09-04T12:00:00Z", firstDiscoveredAt: "2026-09-04T12:00:00Z",
  discoveredAt: 1, lastActivityAt: 1, lastActivityKind: "observed", category: "图片", kind: "image", previewCapability: "image",
  status: "ready", isOrganizable: true, unavailableReason: null,
}));
let request: ReturnType<typeof vi.fn<(id: string) => Promise<string | null>>>;
beforeEach(() => {
  request = vi.fn(async (id: string) => `thumbnail:${id}`);
  Object.defineProperty(window, "sorttie", { configurable: true, value: { getImageThumbnail: request } as unknown as SorttieApi });
});
function setup(visibleIds: readonly string[] = [], priorityId: string | null = null) {
  return renderHook((props: { records: readonly FileRecord[]; visibleIds: readonly string[]; priorityId: string | null }) =>
    useImageThumbnails(props.records, props.visibleIds, props.priorityId), { initialProps: { records: files, visibleIds, priorityId } });
}
function holdRequests() {
  const resolves = new Map<string, (url: string | null) => void>();
  request.mockImplementation((id) => new Promise((resolve) => { resolves.set(id, resolve); }));
  return async (id: string, url = `thumbnail:${id}`) => { await act(async () => { resolves.get(id)!(url); }); };
}

describe("visible image thumbnail queue", () => {
  it("loads nothing offscreen, loads beyond the eighth image, and shares the cache with detail", async () => {
    const view = setup();
    expect(request).not.toHaveBeenCalled();
    view.rerender({ records: files, visibleIds: ["12"], priorityId: null });
    await waitFor(() => expect(view.result.current["12"]).toBe("thumbnail:12"));
    expect(request).toHaveBeenCalledTimes(1);
    view.rerender({ records: files, visibleIds: [], priorityId: "12" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("limits concurrency to three and gives hover the next available slot", async () => {
    const complete = holdRequests();
    const view = setup(["0", "1", "2", "3", "4"]);
    expect(request.mock.calls.flat()).toEqual(["0", "1", "2"]);
    view.rerender({ records: files, visibleIds: ["0", "1", "2", "3", "4"], priorityId: "12" });
    await complete("1");
    expect(request.mock.calls.flat()).toEqual(["0", "1", "2", "12"]);
    expect(view.result.current["1"]).toBe("thumbnail:1"); // Does not wait for the other two.
    await complete("0");
    expect(request.mock.calls.flat()).toEqual(["0", "1", "2", "12", "3"]);
  });

  it("drops queued offscreen items during fast scroll and does not duplicate in-flight work", async () => {
    const complete = holdRequests();
    const view = setup(["0", "1", "2", "3"]);
    view.rerender({ records: files, visibleIds: ["15", "16"], priorityId: "1" });
    await complete("0");
    expect(request.mock.calls.flat()).toEqual(["0", "1", "2", "15"]);
    await complete("1");
    expect(request.mock.calls.flat()).toEqual(["0", "1", "2", "15", "16"]);
  });

  it("isolates failures and retries a failed visible image once on explicit hover", async () => {
    request.mockRejectedValueOnce(new Error("busy"));
    const view = setup(["0", "1"]);
    await waitFor(() => expect(view.result.current["0"]).toBeNull());
    expect(view.result.current["1"]).toBe("thumbnail:1");
    request.mockResolvedValue(null);
    view.rerender({ records: files, visibleIds: ["0", "1"], priorityId: "0" });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(3); // No retry loop on a corrupt image.
  });

  it("ignores obsolete results, refreshes changed files and prunes removed files", async () => {
    const complete = holdRequests();
    const view = setup(["0"]);
    const updated = [{ ...files[0], sizeBytes: 456 }];
    view.rerender({ records: updated, visibleIds: [], priorityId: null });
    await complete("0", "obsolete");
    expect(view.result.current["0"]).toBeUndefined();
    view.rerender({ records: updated, visibleIds: ["0"], priorityId: null });
    await complete("0", "fresh");
    expect(view.result.current["0"]).toBe("fresh");
    view.rerender({ records: [], visibleIds: [], priorityId: null });
    expect(view.result.current).toEqual({});
  });

  it("does not continue the queue after unmount or request downloading/non-image files", async () => {
    const complete = holdRequests();
    const view = setup(["0", "1", "2", "3"]);
    view.unmount();
    await complete("0");
    expect(request).toHaveBeenCalledTimes(3);
    request.mockClear();
    const unavailable = [{ ...files[0], status: "downloading" as const }, { ...files[1], previewCapability: "unsupported" as const }];
    renderHook(() => useImageThumbnails(unavailable, ["0", "1"], "0"));
    expect(request).not.toHaveBeenCalled();
  });
});
