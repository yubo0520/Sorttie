import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChangeEvent, FileRecord, FileSnapshot, OrganizationPlanRequestItem, SorttieApi, WatchDirectoryState } from "../shared/contracts";
import { App } from "./App";

const root = "D:\\Sorttie Test\\真实目录";
const watching: WatchDirectoryState = {
  phase: "watching",
  directory: root,
  message: "正在监控 5 个第一层文件。",
  isWatching: true,
  lastUpdatedAt: "2026-09-03T12:00:00.000Z",
};

function record(seed: string, overrides: Partial<FileRecord> = {}): FileRecord {
  const name = overrides.name ?? `${seed}.log`;
  return {
    id: seed.repeat(64).slice(0, 64),
    name,
    extension: overrides.extension ?? ".log",
    absolutePath: `${root}\\${name}`,
    parentDirectory: root,
    sizeBytes: 42,
    createdAt: "2026-09-03T11:00:00.000Z",
    modifiedAt: "2026-09-03T12:00:00.000Z",
    firstDiscoveredAt: "2026-09-03T11:00:00.000Z",
    discoveredAt: Date.parse("2026-09-03T11:00:00.000Z"),
    lastActivityAt: Date.parse("2026-09-03T12:00:00.000Z"),
    lastActivityKind: "created",
    category: "代码与数据",
    kind: "code",
    previewCapability: "text",
    status: "ready",
    isOrganizable: true,
    unavailableReason: null,
    ...overrides,
  };
}

const image = record("a", { name: "真实 图片.png", extension: ".png", category: "图片", kind: "image", previewCapability: "image" });
const log = record("b", { name: "debug.log" });
const audioFile = record("f", { name: "旁白.wav", extension: ".wav", category: "音频", kind: "audio", previewCapability: "audio" });
const secondAudioFile = record("1", { name: "配乐.mp3", extension: ".mp3", category: "音频", kind: "audio", previewCapability: "audio" });
const unknown = record("c", { name: "素材.unknown", extension: ".unknown", category: "其他", kind: "unknown", previewCapability: "unsupported" });
const downloading = record("d", {
  name: "未完成.crdownload",
  extension: ".crdownload",
  category: "其他",
  kind: "unknown",
  previewCapability: "unsupported",
  status: "downloading",
  isOrganizable: false,
  unavailableReason: "下载尚未完成",
});
const protectedFile = record("e", {
  name: "desktop.ini",
  extension: ".ini",
  status: "protected",
  isOrganizable: false,
  unavailableReason: "系统文件保持原位",
});
const initialFiles = [image, log, unknown, downloading, protectedFile];
const operationId = "op_11111111-1111-4111-8111-111111111111";
const operationIds = [
  operationId,
  "op_22222222-2222-4222-8222-222222222222",
  "op_33333333-3333-4333-8333-333333333333",
];
const planId = "plan_11111111-1111-4111-8111-111111111111";

function snapshot(files: readonly FileRecord[] = initialFiles, state = watching): FileSnapshot {
  return { state, files, reason: "watch" };
}

function installApi(files: readonly FileRecord[] = initialFiles, state = watching) {
  let listener: ((event: FileChangeEvent) => void) | null = null;
  const favorites = new Set<string>();
  const api: SorttieApi = {
    getJianyingProtection: vi.fn(async () => ({ root: null, incomplete: 0, files: [] })),
    chooseJianyingDirectory: vi.fn(async () => ({ root: null, incomplete: 0, files: [] })),
    getAppInfo: vi.fn(async () => ({ name: "Sorttie", version: "test", readOnly: true as const, platform: "win32" as const })),
    chooseWatchDirectory: vi.fn(async () => ({ cancelled: true, snapshot: snapshot(files, state) })),
    getWatchDirectoryState: vi.fn(async () => state),
    getCurrentFiles: vi.fn(async () => files),
    getFavoriteFileIds: vi.fn(async () => ({ directory: state.directory, fileIds: [...favorites] })),
    setFileFavorite: vi.fn(async (fileId, favorite) => { if (favorite) favorites.add(fileId); else favorites.delete(fileId); return { ok: true, code: null, message: favorite ? "已收藏" : "已取消收藏", fileId, favorite }; }),
    rescanWatchDirectory: vi.fn(async () => snapshot(files, state)),
    getImageThumbnail: vi.fn(async (id) => id === image.id ? "data:image/png;base64,AA==" : null),
    openFile: vi.fn(async () => ({ ok: true, message: "已交给系统打开", code: null })),
    openWith: vi.fn(async () => ({ ok: true, message: "已打开“打开方式”", code: null })),
    showItemInFolder: vi.fn(async () => ({ ok: true, message: "已在资源管理器中显示", code: null })),
    copyFilePath: vi.fn(async () => ({ ok: true, message: "已复制文件路径", code: null })),
    copyFolderPath: vi.fn(async () => ({ ok: true, message: "已复制文件夹路径", code: null })),
    startFileDrag: vi.fn(),
    readTextPreview: vi.fn(async () => ({ text: "INFO ready", truncated: false })),
    classifyFileWithLocalAi: vi.fn(async (fileId) => ({
      status: "ready" as const,
      fileId,
      model: "gemma4:e4b",
      category: "文档" as const,
      confidence: 0.78,
      tags: ["资料"],
      reason: "文件名表明它更像一份资料文档。",
      usedTextContent: false,
    })),
    getOrganizationRoot: vi.fn(async () => null),
    prepareOrganizationPlan: vi.fn(async (items: readonly OrganizationPlanRequestItem[], mode = "categorized") => ({
      status: "prepared" as const,
      planId,
      destinationDirectory: "D:\\Sorttie Test\\资料库",
      items: items.filter((item) => mode === "same-location" || item.category !== "其他").map((item, index) => ({
        fileId: item.fileId,
        operationId: operationIds[index],
        destinationPath: `D:\\Sorttie Test\\资料库\\${mode === "same-location" ? "" : `${item.category}\\`}${files.find((file) => file.id === item.fileId)?.name ?? "unknown"}`,
      })),
      code: null,
      message: `已冻结 ${items.length} 项整理计划。`,
    })),
    executeOrganization: vi.fn(async (id) => ({
      status: "moved" as const,
      operationId: id,
      code: null,
      message: "整理完成，可以撤销本次移动。",
    })),
    undoOrganization: vi.fn(async (id) => ({
      status: "undone" as const,
      operationId: id,
      code: null,
      message: "已撤销，文件已回到原位置。",
    })),
    subscribeToFileChanges: vi.fn((next) => {
      listener = next;
      return () => { listener = null; };
    }),
  };
  Object.defineProperty(window, "sorttie", { configurable: true, value: api });
  return {
    api,
    isSubscribed: () => listener !== null,
    emit(filesAfter: readonly FileRecord[], notice: string | null = null, stateAfter = watching) {
      listener?.({ type: "snapshot", snapshot: snapshot(filesAfter, stateAfter), notice });
    },
  };
}

async function waitForFiles() {
  const card = await screen.findByTestId(`home-card-${image.id}`);
  // Initial directory-reset and thumbnail effects must settle before interacting.
  await waitFor(() => expect(card.querySelector("img")).not.toBeNull());
}

async function openPending(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /待整理/ }));
}

async function enterManagement(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("management-toggle"));
  expect(screen.getByTestId("management-toggle")).toHaveTextContent("完成");
}

async function openPreparedPlan(
  user: ReturnType<typeof userEvent.setup>,
  selected: readonly FileRecord[],
) {
  await openPending(user);
  await enterManagement(user);
  for (const file of selected) await user.click(screen.getByTestId(`pending-row-${file.id}`));
  await user.click(screen.getByRole("button", { name: `整理 ${selected.length} 项` }));
  await user.click(screen.getByRole("button", { name: "全部放到同一位置" }));
  await screen.findByTestId("execute-organization");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sorttie.recentView", "list");
  installApi();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });
});

describe("Sorttie renderer", () => {
  it("keeps failed favorites unchanged and blocks duplicate clicks while saving", async () => {
    localStorage.setItem("sorttie.recentView", "icons");
    const { api } = installApi();
    let finish!: (value: Awaited<ReturnType<SorttieApi["setFileFavorite"]>>) => void;
    vi.mocked(api.setFileFavorite).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    const star = await screen.findByRole("button", { name: `${image.name} 收藏` });
    await waitFor(() => expect(star).toBeEnabled());
    fireEvent.click(star);
    fireEvent.click(star);
    expect(api.setFileFavorite).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();
    await act(async () => finish({ ok: false, code: "favorite_save_failed", message: "收藏保存失败", fileId: image.id, favorite: true }));
    await waitFor(() => expect(star).toBeEnabled());
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("收藏保存失败")).toBeVisible();
  });
  it("dismisses notices after three seconds and restarts for repeated messages", async () => {
    const view = render(<App />);
    await waitForFiles();
    vi.useFakeTimers();
    try {
      const notify = () => {
        fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
      };
      notify();
      expect(screen.getByRole("status")).toHaveTextContent("设置将在后续接入");
      expect(within(screen.getByRole("status")).queryByRole("button")).toBeNull();
      act(() => vi.advanceTimersByTime(2000));
      notify();
      act(() => vi.advanceTimersByTime(2999));
      expect(screen.getByRole("status")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("status")).toBeNull();
      notify();
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("starts without inspecting or managing a file", async () => {
    render(<App />);
    await waitForFiles();
    expect(screen.getByTestId(`home-card-${image.id}`)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("batch-bar")).not.toBeInTheDocument();
  });

  it("unsubscribes from filesystem events when the renderer unmounts", async () => {
    const installed = installApi();
    const view = render(<App />);
    await waitForFiles();
    expect(installed.isSubscribed()).toBe(true);
    view.unmount();
    expect(installed.isSubscribed()).toBe(false);
  });

  it("shows the explicit unconnected state and keeps a cancelled choice unchanged", async () => {
    const unconfigured: WatchDirectoryState = { phase: "unconfigured", directory: null, message: "尚未选择监控文件夹。", isWatching: false, lastUpdatedAt: null };
    const { api } = installApi([], unconfigured);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByTestId("directory-state")).toHaveTextContent("选择一个文件夹开始");
    await user.click(screen.getByRole("button", { name: "选择监控文件夹" }));
    expect(api.chooseWatchDirectory).toHaveBeenCalledOnce();
    expect(screen.getByTestId("directory-state")).toHaveTextContent("选择一个文件夹开始");
  });

  it("uses an application popover instead of a native select", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    expect(document.querySelector("select")).not.toBeInTheDocument();
    await openPending(user);
    await user.click(screen.getByTestId("status-filter-trigger"));
    await user.click(within(screen.getByRole("listbox", { name: "状态" })).getByRole("option", { name: "下载中" }));
    expect(screen.getByTestId("status-filter-trigger")).toHaveTextContent("下载中");
  });

  it("opens recent details on demand and clears them with close or Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`home-card-${image.id}`));
    expect(await screen.findByTestId("detail-panel")).toHaveClass("recent-detail-panel", "is-open");
    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`home-card-${image.id}`));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId(`home-card-${image.id}`)).toHaveAttribute("aria-pressed", "false");
  });

  it("expands, filters, clears, and closes the compact search", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.click(screen.getByRole("textbox", { name: "搜索最近文件" }));
    const search = screen.getByRole("textbox", { name: "搜索最近文件" });
    await user.type(search, "素材");
    expect(await screen.findByTestId(`home-card-${unknown.id}`)).toBeVisible();
    expect(screen.queryByTestId(`home-card-${image.id}`)).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: "搜索最近文件" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "搜索最近文件" })).not.toHaveFocus();
    expect(await screen.findByTestId(`home-card-${image.id}`)).toBeVisible();
  });

  it("shows only exceptional activity states and opens Pending from the confirmation strip", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    expect(screen.getByTestId(`activity-row-${unknown.id}`)).not.toHaveTextContent("可整理");
    expect(screen.getByTestId(`activity-row-${downloading.id}`)).toHaveTextContent("下载中");
    await user.click(within(screen.getByTestId("confirmation-strip")).getByRole("button", { name: "查看" }));
    expect(screen.getByRole("heading", { name: "待整理" })).toBeVisible();
  });

  it("keeps just-saved activity out of the Today stream and hides it for an initial scan", async () => {
    const view = render(<App />);
    await waitForFiles();
    expect(screen.queryByTestId(`activity-row-${image.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`activity-row-${log.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`activity-row-${unknown.id}`)).toBeVisible();
    view.unmount();

    const observed = initialFiles.map((file) => ({ ...file, lastActivityKind: "observed" as const }));
    installApi(observed);
    render(<App />);
    expect(await screen.findByTestId(`activity-row-${image.id}`)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "刚刚保存" })).not.toBeInTheDocument();
  });

  it("opens a file once on double click without also opening details", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();

    await user.dblClick(screen.getByTestId(`home-card-${image.id}`));
    await waitFor(() => expect(api.openFile).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();
  });

  it("keeps right-click separate from details and supports the non-modal context menu", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    const row = screen.getByTestId(`activity-row-${unknown.id}`);
    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    const menu = screen.getByTestId("file-context-menu");
    expect(menu).toBeVisible();
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drawer-backdrop")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).not.toHaveAttribute("inert");
    expect(document.querySelector(".activity-more")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(api.openWith).toHaveBeenCalledWith(unknown.id);
    expect(screen.queryByTestId("file-context-menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    fireEvent.scroll(document);
    expect(screen.queryByTestId("file-context-menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("file-context-menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    await user.click(screen.getByRole("menuitem", { name: "复制文件路径" }));
    expect(api.copyFilePath).toHaveBeenCalledWith(unknown.id);
    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    await user.click(screen.getByRole("menuitem", { name: "复制文件夹路径" }));
    expect(api.copyFolderPath).toHaveBeenCalledWith(unknown.id);

    fireEvent.contextMenu(row, { clientX: 900, clientY: 500 });
    await user.click(screen.getByTestId(`home-card-${image.id}`));
    await waitFor(() => expect(screen.getByTestId("detail-file-name")).toHaveTextContent(image.name));
    expect(screen.queryByTestId("file-context-menu")).not.toBeInTheDocument();
  });

  it("does not replace an open Recent detail on right-click and lets the next click act immediately", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.click(screen.getByTestId(`home-card-${image.id}`));
    expect(await screen.findByTestId("detail-file-name")).toHaveTextContent(image.name);

    const row = screen.getByTestId(`activity-row-${unknown.id}`);
    fireEvent.contextMenu(row, { clientX: 320, clientY: 280 });
    expect(screen.getByTestId("detail-file-name")).toHaveTextContent(image.name);
    expect(screen.getByTestId("file-context-menu")).toBeVisible();
    fireEvent.click(row.querySelector(".activity-open")!, { detail: 1 });
    await waitFor(() => expect(screen.getByTestId("detail-file-name")).toHaveTextContent(unknown.name));
    expect(screen.queryByTestId("file-context-menu")).not.toBeInTheDocument();
  });

  it("does not offer hover preview for an unsupported Recent file", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.hover(screen.getByTestId(`activity-row-${unknown.id}`).querySelector(".preview-trigger")!);
    await new Promise((resolve) => setTimeout(resolve, 340));
    expect(screen.queryByTestId("hover-preview")).not.toBeInTheDocument();
  });

  it("offers a reviewed local Gemma suggestion for an unrecognized file", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    fireEvent.click(screen.getByTestId(`activity-row-${unknown.id}`).querySelector(".activity-open")!, { detail: 1 });
    await user.click(await screen.findByRole("tab", { name: "信息" }));
    await user.click(screen.getByRole("button", { name: "让 Gemma 判断" }));
    expect(await screen.findByTestId("local-ai-result")).toHaveTextContent("建议归为“文档”");
    expect(screen.getByTestId("local-ai-result")).toHaveTextContent("文件名表明它更像一份资料文档");
    expect(api.classifyFileWithLocalAi).toHaveBeenCalledWith(unknown.id);
    await user.click(screen.getByRole("button", { name: "采用建议" }));
    await user.click(screen.getByRole("tab", { name: "信息" }));
    expect(screen.getByText("文档", { selector: ".organize-readout dd" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "让 Gemma 判断" })).not.toBeInTheDocument();
  });

  it("loads bounded text previews on demand and starts native drag with a registered id", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.click(screen.getByTestId(`home-card-${log.id}`));
    expect(await screen.findByText("INFO ready")).toBeVisible();
    expect(api.readTextPreview).toHaveBeenCalledWith(log.id);

    fireEvent.dragStart(screen.getByTestId(`home-card-${log.id}`));
    expect(api.startFileDrag).toHaveBeenCalledWith(log.id);
    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    fireEvent.dragStart(screen.getByTestId(`home-card-${log.id}`));
    fireEvent.click(screen.getByTestId(`home-card-${log.id}`), { detail: 1 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(screen.queryByTestId("detail-panel")).not.toBeInTheDocument();
  });

  it("keeps Pending row clicks on the page summary while double-click opens the file", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    expect(screen.getByTestId("detail-panel")).toHaveTextContent("待整理页面摘要");
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    expect(screen.getByTestId("detail-panel")).toHaveTextContent("待整理页面摘要");
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("batch-bar")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId(`pending-row-${log.id}`), { clientX: 400, clientY: 300 });
    expect(screen.getByTestId("file-context-menu")).toBeVisible();
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.dblClick(screen.getByTestId(`pending-row-${log.id}`));
    expect(api.openFile).toHaveBeenCalledWith(log.id);
  });

  it("manages Pending files without opening details and clears selection on exit", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${unknown.id}`));
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    expect(screen.getByTestId("batch-bar")).toHaveTextContent("已选 1 项");
    await user.click(screen.getByTestId("management-toggle"));
    expect(screen.queryByTestId("batch-bar")).not.toBeInTheDocument();
    await enterManagement(user);
    expect(within(screen.getByTestId(`pending-row-${unknown.id}`)).getByRole("button", { name: /选择/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("selects unknown files but skips downloads and protected files", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId("select-all"));
    expect(screen.getByTestId("batch-bar")).toHaveTextContent("已选 3 项");
    expect(within(screen.getByTestId(`pending-row-${unknown.id}`)).getByRole("button", { name: /选择/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId(`pending-row-${downloading.id}`)).getByRole("button")).toBeDisabled();
    expect(within(screen.getByTestId(`pending-row-${protectedFile.id}`)).getByRole("button")).toBeDisabled();
  });

  it("clears the current detail when that file is deleted", async () => {
    const { emit } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.click(screen.getByTestId(`home-card-${image.id}`));
    expect(await screen.findByTestId("detail-file-name")).toHaveTextContent(image.name);
    emit(initialFiles.filter((file) => file.id !== image.id), "移除 1 项");
    await waitFor(() => expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("当前查看的文件已不在监控目录中"));
  });

  it("removes a managed file when it is deleted or becomes unavailable", async () => {
    const { emit } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    await user.click(screen.getByTestId(`pending-row-${unknown.id}`));
    expect(screen.getByTestId("batch-bar")).toHaveTextContent("已选 2 项");
    emit(initialFiles.filter((file) => file.id !== log.id));
    await waitFor(() => expect(screen.getByTestId("batch-bar")).toHaveTextContent("已选 1 项"));
    expect(screen.getByRole("status")).toHaveTextContent("已自动移除不再可整理的文件");
  });

  it("isolates detail and management state across pages", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await user.click(screen.getByTestId(`home-card-${image.id}`));
    await openPending(user);
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    await user.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /最近文件/ }));
    expect(screen.queryByTestId("batch-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-file-name")).not.toBeInTheDocument();
  });

  it("returns from the grouped preview with the management selection intact", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    await user.click(screen.getByRole("button", { name: "整理 1 项" }));
    expect(screen.getByRole("dialog", { name: "整理预览" })).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "返回" })[0]);
    expect(screen.getByTestId("management-toggle")).toHaveTextContent("完成");
    expect(screen.getByTestId("batch-bar")).toHaveTextContent("已选 1 项");
  });

  it("keeps the real move result and undo available after the watcher removes the source", async () => {
    const { api, emit } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    await user.click(screen.getByRole("button", { name: "整理 1 项" }));

    await user.click(screen.getByTestId("prepare-organization"));
    await waitFor(() => expect(api.prepareOrganizationPlan).toHaveBeenCalledWith([{
      fileId: log.id,
      category: "代码与数据",
    }], "categorized"));
    expect(screen.getByText("D:\\Sorttie Test\\资料库", { exact: true })).toBeVisible();
    await user.click(screen.getByTestId("execute-organization"));
    expect(await screen.findByRole("heading", { name: "批量整理完成" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "整理结果" })).toBeVisible();
    expect(screen.getByText(`已整理至：D:\\Sorttie Test\\资料库\\代码与数据\\${log.name}`)).toBeVisible();
    expect(api.executeOrganization).toHaveBeenCalledWith(operationId);

    emit(initialFiles.filter((file) => file.id !== log.id), "移除 1 项");
    await waitFor(() => expect(screen.getByRole("heading", { name: "批量整理完成" })).toBeVisible());
    expect(screen.getByTestId("undo-organization")).toBeVisible();
    expect(screen.queryByText("已自动移除不再可整理的文件")).not.toBeInTheDocument();
    expect(screen.queryByText("移除 1 项")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("undo-organization"));
    expect(await screen.findByRole("heading", { name: "批量撤销完成" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "撤销结果" })).toBeVisible();
    expect(screen.getByText(`已恢复至：${log.absolutePath}`)).toBeVisible();
    expect(api.undoOrganization).toHaveBeenCalledWith(operationId);
  });

  it("executes three frozen items in order and undoes successful moves in reverse order", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPreparedPlan(user, [image, log, unknown]);

    await user.click(screen.getByTestId("execute-organization"));
    expect(await screen.findByRole("heading", { name: "批量整理完成" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "整理结果" })).toBeVisible();
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("成功 3 项");
    expect(screen.getByTestId("plan-dialog")).not.toHaveTextContent("失败 0 项");
    expect(vi.mocked(api.executeOrganization).mock.calls.map(([id]) => id)).toEqual(operationIds);

    await user.click(screen.getByTestId("undo-organization"));
    expect(await screen.findByRole("heading", { name: "批量撤销完成" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "撤销结果" })).toBeVisible();
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("已撤销 3 项");
    expect(screen.getByTestId("plan-dialog")).not.toHaveTextContent("失败 0 项");
    expect(screen.getByTestId("batch-results")).toHaveTextContent(`已恢复至：${image.absolutePath}`);
    expect(screen.getByTestId("batch-results")).toHaveTextContent(`已恢复至：${log.absolutePath}`);
    expect(screen.getByTestId("batch-results")).toHaveTextContent(`已恢复至：${unknown.absolutePath}`);
    expect(vi.mocked(api.undoOrganization).mock.calls.map(([id]) => id)).toEqual([...operationIds].reverse());
  });

  it("groups categorized destinations, leaves Other pending, and executes only frozen eligible items", async () => {
    const { api } = installApi();
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    for (const file of [image, log, unknown]) await user.click(screen.getByTestId(`pending-row-${file.id}`));
    await user.click(screen.getByRole("button", { name: "整理 3 项" }));
    await user.click(screen.getByTestId("prepare-organization"));
    expect(await screen.findByText("D:\\Sorttie Test\\资料库\\图片", { exact: true })).toBeVisible();
    expect(screen.getByText("D:\\Sorttie Test\\资料库\\代码与数据", { exact: true })).toBeVisible();
    expect(screen.getByRole("region", { name: "等待确认去向" })).toHaveTextContent(unknown.name);
    await user.click(screen.getByTestId("execute-organization"));
    await screen.findByRole("heading", { name: "批量整理完成" });
    expect(api.executeOrganization).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "等待确认去向" })).toHaveTextContent("未移动");
  });

  it("reuses a saved root automatically and preserves the frozen plan when root selection is cancelled", async () => {
    const { api } = installApi();
    vi.mocked(api.getOrganizationRoot).mockResolvedValue("D:\\Sorttie Test\\资料库");
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPending(user);
    await enterManagement(user);
    await user.click(screen.getByTestId(`pending-row-${log.id}`));
    await user.click(screen.getByRole("button", { name: "整理 1 项" }));
    await screen.findByTestId("execute-organization");
    expect(api.prepareOrganizationPlan).toHaveBeenCalledWith([{ fileId: log.id, category: log.category }], "categorized");
    vi.mocked(api.prepareOrganizationPlan).mockResolvedValueOnce({ status: "cancelled", planId: null, destinationDirectory: null, items: [], code: null, message: "已取消" });
    await user.click(screen.getByRole("button", { name: "更改根目录" }));
    expect(screen.getByTestId("execute-organization")).toBeEnabled();
    expect(screen.getByText("D:\\Sorttie Test\\资料库\\代码与数据", { exact: true })).toBeVisible();
  });

  it("continues after one preflight block and reports the remaining two successes", async () => {
    const { api, emit } = installApi();
    vi.mocked(api.executeOrganization).mockImplementation(async (id) => id === operationIds[1]
      ? { status: "blocked", operationId: id, code: "source_identity_changed", message: "原文件发生了变化。" }
      : { status: "moved", operationId: id, code: null, message: "整理完成。" });
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPreparedPlan(user, [image, log, unknown]);

    await user.click(screen.getByTestId("execute-organization"));
    await screen.findByRole("heading", { name: "批量整理完成" });
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("成功 2 项");
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("失败 1 项");
    expect(screen.getByTestId("batch-results")).toHaveTextContent("preflight 阻止");
    expect(vi.mocked(api.executeOrganization)).toHaveBeenCalledTimes(3);

    emit([log, downloading, protectedFile], "移除 2 项");
    await waitFor(() => expect(screen.getByRole("heading", { name: "批量整理完成" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId(`pending-row-${image.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`pending-row-${unknown.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`pending-row-${log.id}`)).toBeVisible();
  });

  it("continues with later files after one move fails", async () => {
    const { api } = installApi();
    vi.mocked(api.executeOrganization).mockImplementation(async (id) => id === operationIds[0]
      ? { status: "failed", operationId: id, code: "move_failed", message: "移动失败。" }
      : { status: "moved", operationId: id, code: null, message: "整理完成。" });
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPreparedPlan(user, [image, log, unknown]);

    await user.click(screen.getByTestId("execute-organization"));
    await screen.findByRole("heading", { name: "批量整理完成" });
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("成功 2 项");
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("失败 1 项");
    expect(screen.getByTestId("batch-results")).toHaveTextContent("移动失败");
    expect(vi.mocked(api.executeOrganization).mock.calls.map(([id]) => id)).toEqual(operationIds);
  });

  it("continues reverse-order undo after one moved file cannot be restored", async () => {
    const { api } = installApi();
    vi.mocked(api.undoOrganization).mockImplementation(async (id) => id === operationIds[2]
      ? { status: "blocked", operationId: id, code: "undo_source_occupied", message: "原位置已被占用。" }
      : { status: "undone", operationId: id, code: null, message: "已撤销。" });
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPreparedPlan(user, [image, log, unknown]);

    await user.click(screen.getByTestId("execute-organization"));
    await screen.findByRole("heading", { name: "批量整理完成" });
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("成功 3 项");
    await user.click(screen.getByTestId("undo-organization"));
    await screen.findByRole("heading", { name: "批量撤销完成" });
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("已撤销 2 项");
    expect(screen.getByTestId("plan-dialog")).toHaveTextContent("失败 1 项");
    expect(vi.mocked(api.undoOrganization).mock.calls.map(([id]) => id)).toEqual([...operationIds].reverse());
    expect(screen.getByTestId("batch-results")).toHaveTextContent("撤销失败");
  });

  it("ignores repeated execution clicks while the first operation is running", async () => {
    const { api } = installApi();
    let finishMove!: (value: Awaited<ReturnType<SorttieApi["executeOrganization"]>>) => void;
    vi.mocked(api.executeOrganization).mockImplementation(() => new Promise((resolve) => { finishMove = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await waitForFiles();
    await openPreparedPlan(user, [log]);

    const executeButton = screen.getByTestId("execute-organization");
    fireEvent.click(executeButton);
    fireEvent.click(executeButton);
    expect(api.executeOrganization).toHaveBeenCalledTimes(1);
    finishMove({ status: "moved", operationId, code: null, message: "整理完成。" });
    expect(await screen.findByRole("heading", { name: "批量整理完成" })).toBeVisible();
  });

  it("provides metadata, play, pause, seek, progress, and ended states for audio details", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("pause"));
    });
    installApi([audioFile]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId(`home-card-${audioFile.id}`));
    const player = await screen.findByTestId("detail-panel");
    const audio = player.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 135 });
    Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(audio);
    expect(player).toHaveTextContent("02:15");

    await user.click(within(player).getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledOnce();
    expect(within(player).getByRole("button", { name: "暂停" })).toBeVisible();
    audio.currentTime = 18;
    fireEvent.timeUpdate(audio);
    expect(player).toHaveTextContent("00:18");
    await user.click(within(player).getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalled();
    expect(player).toHaveTextContent("00:18");

    fireEvent.change(within(player).getByRole("slider"), { target: { value: "60" } });
    expect(audio.currentTime).toBe(60);
    audio.currentTime = 135;
    fireEvent.ended(audio);
    expect(within(player).getByRole("button", { name: "播放" })).toBeVisible();
    expect(player).toHaveTextContent("02:15");
  });

  it("stops the old audio on file change or detail close and safely falls back on failure", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    installApi([audioFile, secondAudioFile]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId(`home-card-${audioFile.id}`));
    await screen.findByTestId("detail-file-name");
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    await user.click(screen.getByTestId(`home-card-${secondAudioFile.id}`));
    await waitFor(() => expect(screen.getByTestId("detail-file-name")).toHaveTextContent(secondAudioFile.name));
    expect(pause).toHaveBeenCalled();
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(pause).toHaveBeenCalledTimes(2);

    await user.click(screen.getByTestId(`home-card-${audioFile.id}`));
    await waitFor(() => expect(screen.getByTestId("detail-file-name")).toHaveTextContent(audioFile.name));
    const audio = document.querySelector("audio")!;
    fireEvent.error(audio);
    expect(await within(screen.getByTestId("detail-panel")).findByLabelText("音频预览不可用")).toBeVisible();
  });
});
