import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord, SorttieApi } from "../shared/contracts";
import { RecentPage } from "./recent-page";
import { toFileItem, type FileItem } from "./types";

function file(seed: string, capability: FileRecord["previewCapability"] = "image"): FileItem {
  return toFileItem({ id: seed.repeat(64), name: `${seed}.png`, extension: ".png", absolutePath: `D:\\test\\${seed}.png`, parentDirectory: "D:\\test",
    sizeBytes: 123, createdAt: null, modifiedAt: "2026-09-04T12:00:00Z", firstDiscoveredAt: "2026-09-04T12:00:00Z",
    discoveredAt: 1, lastActivityAt: 1, lastActivityKind: "observed", category: "图片", kind: "image", previewCapability: capability,
    status: "ready", isOrganizable: true, unavailableReason: null }, "data:image/png;base64,AA==");
}
const first = file("a");
const second = file("b");
const unknown = file("c", "unsupported");
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) });
let rowTop = 350;
let readText: ReturnType<typeof vi.fn>;
let intersect: IntersectionObserverCallback;
const disconnect = vi.fn();
function setup(files = [first, second, unknown]) {
  const props = { files, totalFileCount: files.length, pendingCount: 0, selectedId: null,
    favoriteIds: new Set<string>(), favoritePending: new Set<string>(), favoritesReady: true, favoritesOnly: false, onFavoritesOnlyChange: vi.fn(), onToggleFavorite: vi.fn(),
    onInspect: vi.fn(), onVisibleImages: vi.fn(), onHoverImage: vi.fn(), onOpenFile: vi.fn(), onContext: vi.fn(), onDragStart: vi.fn(), onOpenPending: vi.fn(), query: "", onQueryChange: vi.fn(),
    watchState: { phase: "watching" as const, directory: "D:\\test", message: "", isWatching: true, lastUpdatedAt: null },
    onChoose: vi.fn(), onRescan: vi.fn(), onMenuAction: vi.fn() };
  return { ...render(<RecentPage {...props} />), props };
}
const trigger = (f = first) => screen.getByTestId(`activity-row-${f.id}`).querySelector<HTMLElement>(".preview-trigger")!;
async function show(f = first) {
  fireEvent.mouseEnter(trigger(f), { buttons: 0 });
  await act(async () => { vi.advanceTimersByTime(250); });
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sorttie.recentView", "list");
  disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  rowTop = 350;
  readText = vi.fn(async () => ({ text: "real text", truncated: false }));
  Object.defineProperty(window, "sorttie", { configurable: true, value: { readTextPreview: readText } as unknown as SorttieApi });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("recent-body")) return rect(160, 68, 800, 472);
    if (this.classList.contains("activity-row")) return rect(180, rowTop, 760, 48);
    return rect(188, rowTop + 7, 34, 34);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Recent thumbnail hover preview", () => {
  it("toggles card favorites without changing inspection or file actions", async () => {
    const { props } = setup();
    expect(screen.queryByTitle("收藏")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    const star = screen.getByRole("button", { name: `${first.name} 收藏` });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    fireEvent.doubleClick(star);
    fireEvent.contextMenu(star);
    fireEvent.dragStart(star);
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(props.onToggleFavorite).toHaveBeenCalledExactlyOnceWith(first.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(props.onContext).not.toHaveBeenCalled();
    expect(props.onDragStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "密集" }));
    expect(screen.queryByTitle("收藏")).toBeNull();
  });
  it("offers one contextual menu without inspection, including cancellation of a pending click", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: `查看 ${first.name}` }), { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: `${first.name} 的操作` }));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(props.onContext).toHaveBeenCalledOnce();
    expect(props.onContext.mock.calls[0][0]).toBe(first.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `查看 ${first.name}` }), { detail: 1 });
    fireEvent.contextMenu(screen.getByTestId(`activity-row-${first.id}`));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("changes density without changing selection, hover adapters or search", () => {
    const { props, unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-density", "medium");
    fireEvent.click(screen.getByRole("button", { name: "密集" }));
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-density", "dense");
    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onQueryChange).not.toHaveBeenCalled();
    unmount(); setup();
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-density", "dense");
  });
  it("switches and remembers icon view without changing query or inspection; unavailable storage is safe", () => {
    const { props, unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
    expect(localStorage.getItem("sorttie.recentView")).toBe("icons");
    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onQueryChange).not.toHaveBeenCalled();
    unmount();
    const next = setup();
    expect(screen.getByRole("button", { name: "图标视图" })).toHaveAttribute("aria-pressed", "true");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-view", "list");
    next.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    setup();
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
  });

  it("reuses file actions and closes hover when changing views", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    await show();
    expect(screen.getByTestId("hover-preview")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    fireEvent.contextMenu(screen.getByTestId(`activity-row-${first.id}`));
    expect(props.onContext).toHaveBeenCalledWith(first.id, 0, 0);
    expect(props.onInspect).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole("button", { name: `查看 ${first.name}` }));
    expect(props.onOpenFile).toHaveBeenCalledWith(first.id);
    fireEvent.click(screen.getByRole("button", { name: `查看 ${first.name}` }), { detail: 1 });
    await act(async () => { vi.advanceTimersByTime(180); });
    expect(props.onInspect).toHaveBeenCalledWith(first.id);
  });
  it("reports visible image IDs, prioritizes hover without inspecting, and disconnects", () => {
    const { props, unmount } = setup();
    const row = screen.getByTestId(`activity-row-${first.id}`);
    const entry = { target: row, isIntersecting: true, boundingClientRect: row.getBoundingClientRect(), intersectionRatio: 1, intersectionRect: row.getBoundingClientRect(), rootBounds: null, time: 0 };
    act(() => intersect([entry], {} as IntersectionObserver));
    expect(props.onVisibleImages).toHaveBeenLastCalledWith([first.id]);
    fireEvent.mouseEnter(trigger(), { buttons: 0 });
    expect(props.onHoverImage).toHaveBeenLastCalledWith(first.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    fireEvent.mouseLeave(trigger());
    expect(props.onHoverImage).toHaveBeenLastCalledWith(null);
    act(() => intersect([{ ...entry, isIntersecting: false }], {} as IntersectionObserver));
    expect(props.onVisibleImages).toHaveBeenLastCalledWith([]);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it("uses the whole thumbnail with a delay, eye hint and no detail activation", async () => {
    const { props } = setup();
    expect(trigger().querySelector(".preview-eye")).not.toBeNull();
    expect(trigger(unknown).querySelector(".preview-eye")).toBeNull();
    fireEvent.mouseEnter(trigger(), { buttons: 0 });
    await act(async () => { vi.advanceTimersByTime(249); });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId("hover-preview")).toHaveAttribute("data-file-id", first.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    fireEvent.mouseLeave(trigger());
    expect(screen.queryByTestId("hover-preview")).toBeNull();
  });

  it("prefers above without covering the current row or icon lane, and flips at the top", async () => {
    setup();
    await show();
    let preview = screen.getByTestId("hover-preview");
    expect(preview).toHaveAttribute("data-side", "above");
    expect(parseFloat(preview.style.top) + parseFloat(preview.style.height)).toBeLessThan(rowTop);
    expect(parseFloat(preview.style.left)).toBeGreaterThan(222);
    rowTop = 110;
    await show(second);
    preview = screen.getByTestId("hover-preview");
    expect(preview).toHaveAttribute("data-side", "below");
    expect(parseFloat(preview.style.top)).toBeGreaterThan(rowTop + 48);
    expect(parseFloat(preview.style.top) + parseFloat(preview.style.height)).toBeLessThanOrEqual(540);
  });

  it.each(["list", "icons"])("previews clipped bottom rows in %s but rejects fully hidden thumbnails", async (view) => {
    setup();
    if (view === "icons") fireEvent.click(screen.getByRole("button", { name: "图标视图" }));
    rowTop = 520;
    await show();
    const preview = screen.getByTestId("hover-preview");
    expect(preview).toHaveAttribute("data-side", "above");
    expect(parseFloat(preview.style.top) + parseFloat(preview.style.height)).toBeLessThan(rowTop);
    rowTop = 540;
    await show();
    expect(screen.queryByTestId("hover-preview")).toBeNull();
  });

  it("cancels transient visits and ignores unsupported or dragging thumbnails", async () => {
    setup();
    fireEvent.mouseEnter(trigger(), { buttons: 0 });
    fireEvent.mouseLeave(trigger());
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    await show(unknown);
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    fireEvent.mouseEnter(trigger(), { buttons: 1 });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
  });

  it.each(["scroll", "wheel", "resize", "blur", "Escape", "contextmenu", "dragstart", "click"])("dismisses on %s without blocking the original event", async (action) => {
    const { props } = setup();
    await show();
    const row = screen.getByTestId(`activity-row-${first.id}`);
    if (action === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (action === "contextmenu") fireEvent.contextMenu(row);
    else if (action === "dragstart") fireEvent.dragStart(row);
    else if (action === "click") fireEvent.click(row.querySelector("button")!, { detail: 1 });
    else fireEvent(action === "resize" || action === "blur" ? window : document, new Event(action));
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(300); });
    if (action === "contextmenu") expect(props.onContext).toHaveBeenCalledOnce();
    if (action === "dragstart") expect(props.onDragStart).toHaveBeenCalledOnce();
    if (action === "click") expect(props.onInspect).toHaveBeenCalledWith(first.id);
  });

  it("never shows stale text while switching files or after a file changes/disappears", async () => {
    const textA = { ...first, previewCapability: "text" as const };
    const textB = { ...second, previewCapability: "text" as const };
    let resolveOld!: (value: { text: string; truncated: boolean }) => void;
    readText.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { props, rerender } = setup([textA, textB]);
    await show(textA);
    fireEvent.mouseEnter(trigger(textB), { buttons: 0 });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { resolveOld({ text: "obsolete text", truncated: false }); });
    expect(screen.getByTestId("hover-preview")).toHaveTextContent("real text");
    expect(screen.getByTestId("hover-preview")).not.toHaveTextContent("obsolete text");
    rerender(<RecentPage {...props} files={[textA, { ...textB, sizeBytes: 456 }]} />);
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    await show(textA);
    rerender(<RecentPage {...props} files={[]} />);
    expect(screen.queryByTestId("hover-preview")).toBeNull();
  });

  it("falls back on image error and never offers audio playback controls in hover", async () => {
    const audio = { ...second, kind: "audio" as const, previewCapability: "audio" as const };
    setup([first, audio]);
    await show();
    fireEvent.error(screen.getByTestId("hover-preview").querySelector("img")!);
    expect(screen.getByTestId("hover-preview").querySelector('[data-preview-capability="unsupported"]')).not.toBeNull();
    await show(audio);
    const preview = screen.getByTestId("hover-preview");
    const media = preview.querySelector("audio")!;
    expect(media).toHaveAttribute("preload", "metadata");
    expect(media).not.toHaveAttribute("autoplay");
    expect(media.play).toHaveBeenCalledOnce();
    expect(media.muted).toBe(false);
    expect(preview.querySelector("button, input, [controls]")).toBeNull();
  });

  it.each([[1600, 900], [600, 1600], [40, 30]])("fits %s x %s images without a frame, caption, cropping or upscaling", async (width, height) => {
    setup();
    await show();
    const preview = screen.getByTestId("hover-preview");
    const image = preview.querySelector("img")!;
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    fireEvent.load(image);
    expect(parseFloat(preview.style.width) / parseFloat(preview.style.height)).toBeCloseTo(width / height);
    expect(parseFloat(preview.style.width)).toBeLessThanOrEqual(Math.min(width, 304));
    expect(parseFloat(preview.style.height)).toBeLessThanOrEqual(Math.min(height, 224) + 0.001);
    expect(parseFloat(preview.style.top) + parseFloat(preview.style.height)).toBeLessThan(rowTop);
    expect(preview.textContent).toBe("");
    expect(preview.querySelector(".format-mark, .hover-preview-caption")).toBeNull();
  });

  it.each(["audio", "video"] as const)("autoplays %s, repeats its opening segment, and releases it on exit", async (capability) => {
    const item = { ...first, previewCapability: capability, kind: capability };
    setup([item]);
    await show(item);
    const media = screen.getByTestId("hover-preview").querySelector(capability)!;
    Object.defineProperty(media, "duration", { configurable: true, value: 30 });
    media.currentTime = 10;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(0);
    expect(media.play).toHaveBeenCalledTimes(2);
    Object.defineProperty(media, "duration", { value: 3 });
    media.currentTime = 3;
    fireEvent.ended(media);
    expect(media.currentTime).toBe(0);
    fireEvent.mouseLeave(trigger(item));
    expect(media.paused).toBe(true);
    expect(media).not.toHaveAttribute("src");
    expect(media.load).toHaveBeenCalledOnce();
    const count = vi.mocked(media.play).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(media.play).toHaveBeenCalledTimes(count);
  });

  it("stops old playback when switching files, and safely handles a late play rejection", async () => {
    const a = { ...first, previewCapability: "audio" as const };
    const b = { ...second, previewCapability: "audio" as const };
    setup([a, b]);
    await show(a);
    const old = screen.getByTestId("hover-preview").querySelector("audio")!;
    await show(b);
    expect(old.paused).toBe(true);
    expect(old).not.toHaveAttribute("src");
    const current = screen.getByTestId("hover-preview").querySelector("audio")!;
    fireEvent.error(current);
    expect(screen.getByTestId("hover-preview")).toHaveTextContent("此文件暂不支持预览");
    expect(current.paused).toBe(true);
    let reject!: (reason: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await show(a);
    fireEvent.mouseLeave(trigger(a));
    await act(async () => { reject(new Error("decoder unavailable")); });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
  });

  it("cleans up pending preview on unmount", async () => {
    const { unmount } = setup();
    fireEvent.focus(screen.getByTestId(`activity-row-${first.id}`).querySelector("button")!);
    // Mouse activation is tested separately; ensure even a pending request cannot outlive the page.
    fireEvent.mouseEnter(trigger(), { buttons: 0 });
    unmount();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });
});
