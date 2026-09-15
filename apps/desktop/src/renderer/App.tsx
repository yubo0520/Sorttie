import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppPlatform, FileAction, FileRecord, WatchDirectoryState } from "../shared/contracts";
import { Icon } from "./Icon";
import { DetailPanel } from "./detail-panel";
import { OrganizationPreview, PendingPage } from "./pending-workflow";
import { RecentPage, type AppPage } from "./recent-page";
import { useImageThumbnails } from "./use-image-thumbnails";
import { toFileItem, type Category, type FileItem } from "./types";

function needsConfirmation(file: FileItem): boolean {
  return file.status === "conflict" || file.status === "modified" || (file.status === "ready" && file.category === "其他");
}

function Sidebar({ page, onNavigate, availableCount, watchState, onChoose }: {
  page: AppPage;
  onNavigate: (page: AppPage) => void;
  availableCount: number;
  watchState: WatchDirectoryState;
  onChoose: () => void;
}) {
  const primary = [
    { id: "recent" as const, label: "最近文件", icon: "clock" as const, count: 0 },
    { id: "pending" as const, label: "待整理", icon: "spark" as const, count: availableCount },
  ];
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="brand">
        <span className="brand-mark"><Icon name="spark" /></span>
        <span><strong>Sorttie</strong><small>本地文件活动台</small></span>
      </div>
      <nav aria-label="主导航">
        {primary.map((item) => (
          <button type="button" key={item.id} className={page === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}>
            <Icon name={item.icon} /><span>{item.label}</span>{item.count > 0 && <b>{item.count}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-monitor">
          <small>监控位置</small>
          <button type="button" title={watchState.directory ?? "选择监控位置"} onClick={onChoose}><Icon name="folder" /><span>{watchState.directory?.split(/[\\/]/).filter(Boolean).pop() ?? "选择文件夹"}</span><Icon name="chevron" /></button>
          <span className={watchState.isWatching ? "watching" : ""}>{watchState.isWatching ? "正在监控" : watchState.phase === "scanning" ? "正在读取" : "未连接"}</span>
        </div>
        <button type="button" className="settings-entry" title="设置将在后续接入"><Icon name="settings" /><span>设置</span></button>
      </div>
    </aside>
  );
}

type ContextMenuState = { fileId: string; x: number; y: number };
type RecentDetailState = { fileId: string } | null;

function FileContextMenu({ file, position, platform, onAction, onClose }: {
  file: FileItem;
  position: ContextMenuState;
  platform: AppPlatform;
  onAction: (action: FileAction, fileId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const primaryItems = [
    { action: "open" as const, label: "打开" },
    ...(platform === "win32" ? [{ action: "open-with" as const, label: "打开方式" }] : []),
    { action: "show-in-folder" as const, label: "在资源管理器中显示" },
  ];
  const pathItems = [
    { action: "copy-file-path" as const, label: "复制文件路径" },
    { action: "copy-folder-path" as const, label: "复制文件夹路径" },
  ];
  const items = [...primaryItems, ...pathItems];
  const width = 210;
  const height = items.length * 38 + 23;
  const left = Math.max(8, Math.min(position.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(position.y, window.innerHeight - height - 8));

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button");
    first?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnScroll = () => onClose();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const keyDown = (event: ReactKeyboardEvent) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + offset + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      aria-label={`${file.name} 的文件操作`}
      data-testid="file-context-menu"
      style={{ left, top }}
      onKeyDown={keyDown}
    >
      {primaryItems.map((item) => (
        <button type="button" role="menuitem" key={item.action} onClick={() => onAction(item.action, file.id)}>{item.label}</button>
      ))}
      <div className="context-menu-separator" role="separator" />
      {pathItems.map((item) => (
        <button type="button" role="menuitem" key={item.action} onClick={() => onAction(item.action, file.id)}>{item.label}</button>
      ))}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<AppPage>("recent");
  const [platform, setPlatform] = useState<AppPlatform>("win32");
  const [watchState, setWatchState] = useState<WatchDirectoryState>({
    phase: "scanning",
    directory: null,
    message: "正在恢复监控状态…",
    isWatching: false,
    lastUpdatedAt: null,
  });
  const [records, setRecords] = useState<readonly FileRecord[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoriteRefresh, setFavoriteRefresh] = useState(0);
  const [favoritePending, setFavoritePending] = useState<ReadonlySet<string>>(new Set());
  const favoriteInFlight = useRef(new Set<string>());
  const favoriteGeneration = useRef(0);
  const currentDirectory = useRef(watchState.directory);
  currentDirectory.current = watchState.directory;
  const [recentDetail, setRecentDetail] = useState<RecentDetailState>(null);
  const [managementMode, setManagementMode] = useState(false);
  const [managedFileIds, setManagedFileIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [categoriesById, setCategoriesById] = useState<Record<string, Category>>({});
  const [foldersById, setFoldersById] = useState<Record<string, string>>({});
  const [visibleImageIds, setVisibleImageIds] = useState<readonly string[]>([]);
  const [hoverImageId, setHoverImageId] = useState<string | null>(null);
  const thumbnails = useImageThumbnails(records, page === "recent" ? visibleImageIds : [], recentDetail?.fileId ?? hoverImageId);
  const [liveNotice, updateLiveNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setLiveNotice = useCallback((message: string) => {
    clearTimeout(noticeTimer.current);
    updateLiveNotice(message);
    noticeTimer.current = message ? setTimeout(() => updateLiveNotice(""), 3000) : undefined;
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const previousDirectory = useRef<string | null>(null);
  const suppressInspectUntil = useRef(0);
  const planOpenRef = useRef(planOpen);
  planOpenRef.current = planOpen;

  useEffect(() => {
    const api = window.sorttie;
    if (!api) {
      setWatchState({ phase: "error", directory: null, message: "无法连接桌面只读服务，请重新启动 Sorttie。", isWatching: false, lastUpdatedAt: null });
      return;
    }
    let active = true;
    const unsubscribe = api.subscribeToFileChanges((event) => {
      if (!active) return;
      setWatchState(event.snapshot.state);
      setRecords(event.snapshot.files);
      if (event.notice && !planOpenRef.current) {
        setLiveNotice(event.notice);
      }
    });
    void Promise.all([api.getWatchDirectoryState(), api.getCurrentFiles(), api.getAppInfo()])
      .then(([state, files, appInfo]) => {
        if (!active) return;
        setWatchState(state);
        setRecords(files);
        setPlatform(appInfo.platform);
      })
      .catch(() => {
        if (active) setWatchState({ phase: "error", directory: null, message: "无法读取监控状态，请重新启动 Sorttie。", isWatching: false, lastUpdatedAt: null });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (planOpen) setLiveNotice("");
  }, [planOpen, setLiveNotice]);

  useEffect(() => {
    const generation = ++favoriteGeneration.current;
    setFavoritesReady(false);
    void window.sorttie?.getFavoriteFileIds().then((snapshot) => {
      if (generation !== favoriteGeneration.current || snapshot.directory !== currentDirectory.current) return;
      setFavoriteIds(new Set(snapshot.fileIds));
      setFavoritesReady(true);
    }).catch(() => {
      if (generation === favoriteGeneration.current) setLiveNotice("收藏读取失败，请重新扫描重试");
    });
    return () => { ++favoriteGeneration.current; };
  }, [records, watchState.directory, favoriteRefresh, setLiveNotice]);

  const toggleFavorite = async (fileId: string) => {
    if (!favoritesReady || favoriteInFlight.current.has(fileId)) return;
    const api = window.sorttie;
    if (!api) return;
    const directory = currentDirectory.current;
    favoriteInFlight.current.add(fileId);
    setFavoritePending(new Set(favoriteInFlight.current));
    ++favoriteGeneration.current;
    try {
      const result = await api.setFileFavorite(fileId, !favoriteIds.has(fileId));
      if (currentDirectory.current !== directory) return;
      if (result.ok && result.fileId === fileId) setFavoriteIds((current) => {
        const next = new Set(current); if (result.favorite) next.add(fileId); else next.delete(fileId); return next;
      });
      setLiveNotice(result.message);
    } catch { if (currentDirectory.current === directory) setLiveNotice("收藏保存失败，请稍后重试"); }
    finally {
      favoriteInFlight.current.delete(fileId);
      setFavoritePending(new Set(favoriteInFlight.current));
      if (currentDirectory.current === directory) {
        ++favoriteGeneration.current;
        setFavoriteRefresh((value) => value + 1);
      }
    }
  };

  useEffect(() => {
    if (previousDirectory.current === watchState.directory) return;
    previousDirectory.current = watchState.directory;
    setRecentDetail(null);
    setManagementMode(false);
    setManagedFileIds(new Set());
    setPlanOpen(false);
    setCategoriesById({});
    setFoldersById({});
    setContextMenu(null);
    setFavoriteIds(new Set());
    setFavoritesOnly(false);
  }, [watchState.directory]);

  useEffect(() => {
    const recordById = new Map(records.map((file) => [file.id, file]));
    if (recentDetail && !recordById.has(recentDetail.fileId)) {
      setRecentDetail(null);
      setLiveNotice("当前查看的文件已不在监控目录中");
    }
    if (contextMenu && !recordById.has(contextMenu.fileId)) setContextMenu(null);
    const retained = new Set([...managedFileIds].filter((id) => recordById.get(id)?.isOrganizable));
    if (retained.size !== managedFileIds.size) {
      setManagedFileIds(retained);
      if (!planOpen) setLiveNotice("已自动移除不再可整理的文件");
    }
  }, [records, recentDetail, managedFileIds, contextMenu, planOpen]);

  const files = useMemo(
    () => records.map((record) => toFileItem(record, thumbnails[record.id])),
    [records, thumbnails],
  );
  const detailFile = files.find((file) => file.id === recentDetail?.fileId);
  const contextFile = files.find((file) => file.id === contextMenu?.fileId);
  const visibleHomeFiles = useMemo(() => files.filter((file) => {
    return (!favoritesOnly || favoriteIds.has(file.id)) && file.name.toLowerCase().includes(query.trim().toLowerCase());
  }), [files, query, favoritesOnly, favoriteIds]);
  const previewFiles = files.filter((file) => managedFileIds.has(file.id));
  const pendingCount = files.filter(needsConfirmation).length;

  const chooseDirectory = async () => {
    try {
      const result = await window.sorttie?.chooseWatchDirectory();
      if (!result || result.cancelled) return;
      setWatchState(result.snapshot.state);
      setRecords(result.snapshot.files);
    } catch {
      setLiveNotice("无法打开或连接所选文件夹");
    }
  };

  const rescan = async () => {
    try {
      const snapshot = await window.sorttie?.rescanWatchDirectory();
      if (!snapshot) return;
      setWatchState(snapshot.state);
      setRecords(snapshot.files);
    } catch {
      setLiveNotice("重新扫描失败，请稍后再试");
    }
  };

  const inspectRecent = (id: string) => {
    if (Date.now() < suppressInspectUntil.current) return;
    setContextMenu(null);
    setRecentDetail({ fileId: id });
  };

  const closeDetail = () => {
    setContextMenu(null);
    setRecentDetail(null);
  };

  const navigate = (next: AppPage) => {
    setPage(next);
    setRecentDetail(null);
    setManagementMode(false);
    setManagedFileIds(new Set());
    setPlanOpen(false);
    setContextMenu(null);
  };

  const changeManagementMode = (enabled: boolean) => {
    setManagementMode(enabled);
    if (!enabled) setManagedFileIds(new Set());
  };

  useEffect(() => {
    if (page !== "recent" || !recentDetail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (contextMenu) return;
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [page, recentDetail, contextMenu]);

  const runFileAction = async (action: FileAction, fileId: string) => {
    setContextMenu(null);
    const api = window.sorttie;
    if (!api) return;
    try {
      const result = action === "open"
        ? await api.openFile(fileId)
        : action === "open-with"
          ? await api.openWith(fileId)
          : action === "show-in-folder"
            ? await api.showItemInFolder(fileId)
            : action === "copy-file-path"
              ? await api.copyFilePath(fileId)
              : await api.copyFolderPath(fileId);
      setLiveNotice(result.message);
    } catch {
      setLiveNotice("无法完成文件操作，请确认文件仍然可用");
    }
  };

  const openContextMenu = (fileId: string, x: number, y: number) => {
    setContextMenu({ fileId, x, y });
  };

  const startDrag = (fileId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    suppressInspectUntil.current = Date.now() + 400;
    setContextMenu(null);
    window.sorttie?.startFileDrag(fileId);
  };

  return (
    <div className={`app-shell page-${page}${files.length ? " has-detail" : ""}${recentDetail && detailFile ? " detail-drawer-open" : ""}`} data-testid="app-shell">
      <Sidebar page={page} onNavigate={navigate} availableCount={pendingCount} watchState={watchState} onChoose={() => void chooseDirectory()} />
      {page === "recent" ? (
        <RecentPage
          files={visibleHomeFiles}
          favoriteIds={favoriteIds}
          favoritePending={favoritePending}
          favoritesReady={favoritesReady}
          favoritesOnly={favoritesOnly}
          onFavoritesOnlyChange={(value) => { setFavoritesOnly(value); setRecentDetail(null); setContextMenu(null); }}
          onToggleFavorite={(id) => { void toggleFavorite(id); }}
          totalFileCount={files.length}
          pendingCount={pendingCount}
          selectedId={recentDetail?.fileId ?? null}
          onInspect={inspectRecent}
          onVisibleImages={setVisibleImageIds}
          onHoverImage={setHoverImageId}
          onOpenFile={(id) => { void runFileAction("open", id); }}
          onContext={openContextMenu}
          onDragStart={startDrag}
          onOpenPending={() => navigate("pending")}
          query={query}
          onQueryChange={setQuery}
          watchState={watchState}
          onChoose={() => void chooseDirectory()}
          onRescan={() => void rescan()}
          onMenuAction={setLiveNotice}
        />
      ) : (
        <PendingPage
          files={files}
          onOpenFile={(id) => { void runFileAction("open", id); }}
          onContext={openContextMenu}
          onDragStart={startDrag}
          managementMode={managementMode}
          onManagementChange={changeManagementMode}
          managedFileIds={managedFileIds}
          setManagedFileIds={setManagedFileIds}
          onPreview={() => setPlanOpen(true)}
          watchState={watchState}
          onChoose={() => void chooseDirectory()}
          onRescan={() => void rescan()}
        />
      )}
      {files.length > 0 && page === "recent" && recentDetail && detailFile && <button type="button" className="drawer-backdrop" aria-label="关闭详情遮罩" data-testid="drawer-backdrop" onClick={closeDetail} />}
      {files.length > 0 && (page === "pending" || (page === "recent" && recentDetail && detailFile)) && (
        <DetailPanel
          page={page}
          files={files}
          file={page === "recent" ? detailFile : undefined}
          favorite={Boolean(detailFile && favoriteIds.has(detailFile.id))}
          favoriteBusy={!favoritesReady || Boolean(detailFile && favoritePending.has(detailFile.id))}
          onToggleFavorite={(id) => { void toggleFavorite(id); }}
          category={detailFile ? categoriesById[detailFile.id] ?? detailFile.category : undefined}
          folder={detailFile ? foldersById[detailFile.id] ?? detailFile.suggestedFolder : undefined}
          open={page === "recent" && Boolean(recentDetail)}
          onCategoryChange={(id, category) => setCategoriesById((current) => ({ ...current, [id]: category }))}
          onFolderChange={(id, folder) => setFoldersById((current) => ({ ...current, [id]: folder }))}
          onFileAction={(action, id) => { void runFileAction(action, id); }}
          onClose={closeDetail}
        />
      )}
      {contextMenu && contextFile && (
        <FileContextMenu file={contextFile} position={contextMenu} platform={platform} onAction={(action, id) => { void runFileAction(action, id); }} onClose={closeContextMenu} />
      )}
      {planOpen && <OrganizationPreview files={previewFiles} categoriesById={categoriesById} foldersById={foldersById} onClose={() => setPlanOpen(false)} />}
      {liveNotice && (
        <div className="live-notice" role="status">
          <span>{liveNotice}</span>
        </div>
      )}
    </div>
  );
}
