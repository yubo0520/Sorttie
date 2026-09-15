import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { WatchDirectoryState } from "../shared/contracts";
import { Icon } from "./Icon";
import { FilePreview, FileCardPreview, kindIcons, statusClass } from "./file-presentation";
import type { FileItem } from "./types";

export type AppPage = "recent" | "pending";

export function DirectoryState({ page, state, onChoose, onRetry }: {
  page: AppPage;
  state: WatchDirectoryState;
  onChoose: () => void;
  onRetry: () => void;
}) {
  const unconfigured = state.phase === "unconfigured";
  const inaccessible = state.phase === "inaccessible" || state.phase === "error";
  const scanning = state.phase === "scanning";
  const title = unconfigured
    ? "选择一个文件夹开始"
    : scanning
      ? "正在读取第一层文件"
      : inaccessible
        ? "监控位置不可访问"
        : page === "recent"
          ? "这个目录暂时没有文件活动"
          : "当前没有待整理文件";
  return (
    <div className={`empty-state state-${state.phase}`} data-testid="directory-state">
      <span className="empty-illustration"><Icon name={inaccessible ? "warning" : scanning ? "refresh" : page === "recent" ? "clock" : "spark"} /></span>
      <h2>{title}</h2>
      <p>{unconfigured ? "Sorttie 只会查看你明确选择的目录，不会自动扫描其他位置。" : state.message}</p>
      {state.directory && <span className="state-path" title={state.directory}>{state.directory}</span>}
      {!scanning && (
        <div className="state-actions">
          {inaccessible && <button type="button" className="secondary-button" onClick={onRetry}>重试</button>}
          {state.phase === "empty" && <button type="button" className="secondary-button" onClick={onRetry}>重新扫描</button>}
          <button type="button" className="primary-button" onClick={onChoose}>{state.directory ? "重新选择" : "选择监控文件夹"}</button>
        </div>
      )}
    </div>
  );
}

function directoryLabel(directory: string | null): string {
  if (!directory) return "尚未连接";
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? directory;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function useFileActivation(fileId: string, onInspect: (id: string) => void, onOpen: (id: string) => void) {
  const clickTimer = useRef<number | null>(null);
  const cancel = () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
  };
  useEffect(() => () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
  }, []);
  return {
    cancel,
    onClick: (event: ReactMouseEvent) => {
      if (event.detail > 1) return;
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        onInspect(fileId);
      }, 180);
    },
    onDoubleClick: (event: ReactMouseEvent) => {
      event.preventDefault();
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onOpen(fileId);
    },
  };
}

type FileSurfaceActions = {
  onInspect: (id: string) => void;
  onOpen: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  onDragStart: (id: string, event: DragEvent<HTMLElement>) => void;
};

function HomeCard({ file, active, onInspect, onOpen, onContext, onDragStart }: { file: FileItem; active: boolean } & FileSurfaceActions) {
  const activation = useFileActivation(file.id, onInspect, onOpen);
  return (
    <div
      className={`home-card card-${file.kind}${active ? " is-active" : ""}`}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); activation.cancel(); onContext(file.id, event.clientX, event.clientY); }}
      draggable
      onDragStart={(event) => { activation.cancel(); onDragStart(file.id, event); }}
      data-thumbnail-id={file.previewCapability === "image" ? file.id : undefined}
    >
      <button type="button" className="home-card-open" data-testid={`home-card-${file.id}`} aria-pressed={active} aria-label={`查看 ${file.name}`} onClick={activation.onClick} onDoubleClick={activation.onDoubleClick}>
      <span className="preview-trigger">
        <FilePreview file={file} />
      </span>
      <span className="card-copy">
        <span className="card-title" title={file.name}>{file.name}</span>
        <span className="card-meta"><span>{file.size}</span><span>{timeLabel(file.modifiedAt)}</span></span>
        <span className="card-location"><Icon name="folder" />{directoryLabel(file.parentDirectory)}</span>
      </span>
      {file.status !== "ready" && <span className={`status-pill ${statusClass[file.status]}`}>{file.statusLabel}</span>}
      </button>
      <button type="button" className="file-more icon-button" aria-label={`${file.name} 的操作`} title="文件操作" aria-haspopup="menu"
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); activation.cancel(); const box = event.currentTarget.getBoundingClientRect(); onContext(file.id, box.right - 210, box.bottom + 4); }}><Icon name="more" /></button>
    </div>
  );
}

function ActivityRow({ file, active, onInspect, onOpen, onContext, onDragStart, onPreview, onPreviewLeave, previewing, rich, onFavorite, favorite, favoriteBusy }: {
  file: FileItem; active: boolean;
  onPreview: (file: FileItem, anchor: HTMLElement) => void;
  onPreviewLeave: () => void;
  previewing: boolean;
  rich: boolean;
  onFavorite: () => void;
  favorite: boolean;
  favoriteBusy: boolean;
} & FileSurfaceActions) {
  const activation = useFileActivation(file.id, onInspect, onOpen);
  const cardRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!rich || !cardRef.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: cardRef.current.closest(".recent-body") });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [rich]);
  const canPreview = file.previewCapability !== "unsupported" && file.status !== "downloading";
  return (
    <div
      ref={cardRef}
      className={`activity-row file-kind-${file.kind}${active ? " is-active" : ""}`}
      data-testid={`activity-row-${file.id}`}
      data-thumbnail-id={file.previewCapability === "image" ? file.id : undefined}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); activation.cancel(); onContext(file.id, event.clientX, event.clientY); }}
      draggable
      onDragStart={(event) => { activation.cancel(); onDragStart(file.id, event); }}
    >
      <button type="button" className="activity-open" onClick={activation.onClick} onDoubleClick={activation.onDoubleClick} aria-label={`查看 ${file.name}`}
        onFocus={(event) => { if (canPreview && event.currentTarget.matches(":focus-visible")) onPreview(file, event.currentTarget.querySelector<HTMLElement>(".preview-trigger")!); }}
        onBlur={onPreviewLeave}>
        <span className={`activity-kind kind-${file.kind} preview-trigger`}
          aria-label={canPreview ? "悬停预览" : undefined}
          aria-describedby={previewing ? "recent-hover-preview" : undefined}
          onMouseEnter={(event) => { if (canPreview && event.buttons === 0) onPreview(file, event.currentTarget); }}
          onMouseLeave={onPreviewLeave}>
          {rich && visible && file.status !== "downloading" ? <FileCardPreview file={file} /> : file.kind === "image" && file.thumbnailUrl ? <img src={file.thumbnailUrl} alt="" /> : <Icon name={kindIcons[file.kind]} />}
          {canPreview && <span className="preview-eye"><Icon name="eye" /></span>}
        </span>
        <span className="activity-format" aria-hidden="true">{file.extension.replace(/^\./, "").toUpperCase() || "FILE"}</span>
        <span className="activity-name" title={file.name}>{file.name}</span>
        <span className="activity-source" title={file.parentDirectory}>{directoryLabel(file.parentDirectory)}</span>
        <span className="activity-size">{file.size}</span>
        <time dateTime={file.modifiedAt}>{timeLabel(file.modifiedAt)}</time>
        {file.status !== "ready" && <span className={`activity-status ${statusClass[file.status]}`}><i />{file.statusLabel}</span>}
      </button>
      {rich && <button type="button" className="card-favorite" aria-label={`${file.name} ${favorite ? "取消收藏" : "收藏"}`} aria-pressed={favorite} disabled={favoriteBusy} title={favorite ? "取消收藏" : "收藏"}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); activation.cancel(); onFavorite(); }}><Icon name="star" fill={favorite ? "currentColor" : "none"} /></button>}
      <button type="button" className="file-more icon-button" aria-label={`${file.name} 的操作`} title="文件操作" aria-haspopup="menu"
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); activation.cancel(); const box = event.currentTarget.getBoundingClientRect(); onContext(file.id, box.right - 210, box.bottom + 4); }}><Icon name="more" /></button>
    </div>
  );
}

export function RecentPage({ files, totalFileCount, pendingCount, selectedId, onInspect, onVisibleImages, onHoverImage, onOpenFile, onContext, onDragStart, onOpenPending, query, onQueryChange, watchState, onChoose, onRescan, onMenuAction, favoriteIds, favoritePending, favoritesReady, favoritesOnly, onFavoritesOnlyChange, onToggleFavorite }: {
  favoriteIds: ReadonlySet<string>;
  favoritePending: ReadonlySet<string>;
  favoritesReady: boolean;
  favoritesOnly: boolean;
  onFavoritesOnlyChange: (value: boolean) => void;
  onToggleFavorite: (id: string) => void;
  files: FileItem[];
  totalFileCount: number;
  pendingCount: number;
  selectedId: string | null;
  onInspect: (id: string) => void;
  onVisibleImages: (ids: readonly string[]) => void;
  onHoverImage: (id: string | null) => void;
  onOpenFile: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  onDragStart: (id: string, event: DragEvent<HTMLElement>) => void;
  onOpenPending: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  watchState: WatchDirectoryState;
  onChoose: () => void;
  onRescan: () => void;
  onMenuAction: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [density, setDensity] = useState<"dense" | "medium" | "spacious">(() => {
    try { const saved = localStorage.getItem("sorttie.cardDensity"); return saved === "dense" || saved === "spacious" ? saved : "medium"; }
    catch { return "medium"; }
  });
  const [view, setView] = useState<"list" | "icons">(() => {
    try { return localStorage.getItem("sorttie.recentView") === "list" ? "list" : "icons"; }
    catch { return "icons"; }
  });
  const scrollPositions = useRef({ list: 0, icons: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{
    fileId: string; modifiedAt: string; sizeBytes: number;
    left: number; top: number; width: number; height: number; maxWidth: number; maxHeight: number; side: "above" | "below";
  } | null>(null);
  const showDirectoryState = totalFileCount === 0 || ["unconfigured", "inaccessible", "error"].includes(watchState.phase);
  const justSaved = view === "list" && !favoritesOnly ? files.filter((file) => file.lastActivityKind === "created" || file.lastActivityKind === "modified").slice(0, 2) : [];
  const justSavedIds = new Set(justSaved.map((file) => file.id));
  const today = files.filter((file) => !justSavedIds.has(file.id));
  const hoverFile = today.find((file) => file.id === hoverPreview?.fileId && file.modifiedAt === hoverPreview.modifiedAt && file.sizeBytes === hoverPreview.sizeBytes && file.status !== "downloading" && file.previewCapability !== "unsupported");
  const imageIds = files.filter((file) => file.previewCapability === "image").map((file) => `${file.id}:${file.lastActivityKind}`).join(",");

  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = scrollPositions.current[view];
  }, [view]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.thumbnailId!;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      onVisibleImages([...visible]);
    }, { root });
    root.querySelectorAll("[data-thumbnail-id]").forEach((node) => observer.observe(node));
    return () => { observer.disconnect(); onVisibleImages([]); onHoverImage(null); };
  }, [imageIds, showDirectoryState, view, onVisibleImages, onHoverImage]);

  const closeHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHoverPreview(null);
    onHoverImage(null);
  };

  const startHover = (file: FileItem, anchor: HTMLElement) => {
    closeHover();
    if (selectedId || menuOpen) return;
    onHoverImage(file.previewCapability === "image" ? file.id : null);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      if (!anchor.isConnected || !bodyRef.current) return;
      const bounds = bodyRef.current.getBoundingClientRect();
      const icon = anchor.getBoundingClientRect();
      const row = anchor.closest(".activity-row")!.getBoundingClientRect();
      const topEdge = Math.max(8, bounds.top + 8);
      const bottomEdge = Math.min(window.innerHeight - 8, bounds.bottom - 8);
      const above = row.top - 8 - topEdge;
      const below = bottomEdge - row.bottom - 8;
      const side = above >= 224 || above >= below ? "above" : "below";
      const height = Math.min(224, side === "above" ? above : below);
      // Stay to the right of the icon lane, leaving the next hover target reachable.
      const width = view === "icons" ? Math.min(304, bounds.width - 24) : Math.min(304, bounds.right - 12 - icon.right - 8, window.innerWidth - 12 - icon.right - 8);
      const left = view === "icons"
        ? Math.max(bounds.left + 8, Math.min(icon.left, bounds.right - 12 - width))
        : icon.right + 8;
      const visibleIcon = icon.bottom > Math.max(bounds.top, 0) && icon.top < Math.min(bounds.bottom, window.innerHeight)
        && icon.right > Math.max(bounds.left, 0) && icon.left < Math.min(bounds.right, window.innerWidth);
      if (height < 96 || width < 160 || !visibleIcon) return;
      const initialHeight = file.previewCapability === "audio" ? 28 : height;
      setHoverPreview({ fileId: file.id, modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes, left, width, height: initialHeight, maxWidth: width, maxHeight: height,
        top: side === "above" ? row.top - 8 - initialHeight : row.bottom + 8, side });
    }, 250);
  };

  useEffect(() => {
    const dismiss = () => closeHover();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("wheel", dismiss, { passive: true });
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("wheel", dismiss);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const closeSearch = () => {
    onQueryChange("");
  };

  const chooseMenuItem = (message: string) => {
    setMenuOpen(false);
    onMenuAction(message);
  };

  const changeView = (next: "list" | "icons") => {
    if (next === view) return;
    scrollPositions.current[view] = bodyRef.current?.scrollTop ?? 0;
    closeHover();
    setView(next);
    try { localStorage.setItem("sorttie.recentView", next); } catch { /* View remains usable without persistence. */ }
  };

  return (
    <main className={`workspace recent-workspace${view === "icons" ? " recent-icon-view" : ""}`} data-testid="workspace" data-view={view} data-density={density} onClickCapture={closeHover} onContextMenuCapture={closeHover} onDragStartCapture={closeHover}>
      <header className="workspace-header recent-header" data-testid="workspace-header">
        <h1 className="visually-hidden">最近文件</h1>
        <label className="search-box persistent-search" data-testid="home-search"><Icon name="search" /><input ref={searchRef} aria-label="搜索最近文件" placeholder="搜索文件名" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { closeSearch(); event.currentTarget.blur(); } }} />{query ? <button type="button" aria-label="清空搜索" onClick={closeSearch}>×</button> : <kbd>Ctrl K</kbd>}</label>
        <div className="toolbar recent-toolbar">
          {view === "icons" && <div className="card-density" role="group" aria-label="卡片密度">
            {(["dense", "medium", "spacious"] as const).map((value, index) => <button type="button" key={value} aria-pressed={density === value} onClick={() => {
              closeHover(); setDensity(value); try { localStorage.setItem("sorttie.cardDensity", value); } catch { /* session preference remains usable */ }
            }}>{["密集", "适中", "宽松"][index]}</button>)}
          </div>}
          <div className="recent-view-switch" role="group" aria-label="文件视图">
            <button type="button" title="列表视图" aria-label="列表视图" aria-pressed={view === "list"} onClick={() => changeView("list")}><Icon name="list" /></button>
            <button type="button" title="图标视图" aria-label="图标视图" aria-pressed={view === "icons"} onClick={() => changeView("icons")}><Icon name="grid" /></button>
          </div>
          <div className="more-anchor" ref={menuRef}>
            <button type="button" className={`icon-button header-icon${menuOpen ? " is-open" : ""}`} title="更多操作" aria-label="更多操作" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((current) => !current)}><Icon name="more" /></button>
            {menuOpen && (
              <div className="home-menu" role="menu" data-testid="home-menu">
                <button type="button" role="menuitemcheckbox" aria-checked={favoritesOnly} onClick={() => { setMenuOpen(false); closeHover(); onFavoritesOnlyChange(!favoritesOnly); }}><Icon name="star" />仅看收藏</button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onChoose(); }}><Icon name="folder" />重新选择监控位置</button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRescan(); }}><Icon name="refresh" />重新扫描</button>
                <button type="button" role="menuitem" onClick={() => chooseMenuItem("设置将在后续接入")}><Icon name="settings" />设置</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="workspace-body recent-body" ref={bodyRef}>
        {showDirectoryState ? <DirectoryState page="recent" state={watchState} onChoose={onChoose} onRetry={onRescan} /> : files.length === 0 ? (
          <div className="filter-empty"><Icon name={favoritesOnly ? "star" : "search"} /><strong>{favoritesOnly ? "当前目录没有匹配的收藏" : "没有找到匹配的文件"}</strong><span>{favoritesOnly ? "收藏只标记文件，不改变文件位置。" : "试试更短的文件名关键词。"}</span>{favoritesOnly && <button type="button" className="text-button" onClick={() => onFavoritesOnlyChange(false)}>显示全部文件</button>}</div>
        ) : (
          <div className="recent-content">
            {justSaved.length > 0 && (
              <section className="just-saved" aria-labelledby="just-saved-title">
                <h2 id="just-saved-title"><i />刚刚保存</h2>
                <div className="home-grid">
                  {justSaved.map((file) => <HomeCard key={file.id} file={file} active={selectedId === file.id} onInspect={onInspect} onOpen={onOpenFile} onContext={onContext} onDragStart={onDragStart} />)}
                </div>
              </section>
            )}
            {pendingCount > 0 && (
              <div className="confirmation-strip reference-confirmation" data-testid="confirmation-strip">
                <span><Icon name="info" /><strong>{pendingCount} 项需要确认</strong></span>
                <button type="button" className="primary-button" onClick={onOpenPending}>查看</button>
              </div>
            )}
            {today.length > 0 && (
              <section className="today-stream" aria-labelledby="today-title">
                <h2 id="today-title">{favoritesOnly ? "收藏" : "今天"} <small>{favoritesOnly ? "当前监控目录" : new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</small>{favoritesOnly && <button type="button" className="text-button" onClick={() => onFavoritesOnlyChange(false)}>显示全部</button>}</h2>
                <div className="activity-list">
                  {today.map((file) => <ActivityRow key={file.id} file={file} rich={view === "icons" && density !== "dense"} favorite={favoriteIds.has(file.id)} favoriteBusy={!favoritesReady || favoritePending.has(file.id)} onFavorite={() => onToggleFavorite(file.id)} active={selectedId === file.id} onInspect={onInspect} onOpen={onOpenFile} onContext={onContext} onDragStart={onDragStart} onPreview={startHover} onPreviewLeave={closeHover} previewing={hoverFile?.id === file.id} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      {hoverPreview && hoverFile && !selectedId && !showDirectoryState && createPortal(
        <aside id="recent-hover-preview" role="tooltip" inert className="recent-hover-preview" data-testid="hover-preview" data-file-id={hoverFile.id} data-side={hoverPreview.side}
          style={{ left: hoverPreview.left, top: hoverPreview.top, width: hoverPreview.width, height: hoverPreview.height }}>
          <FilePreview file={hoverFile} hover onSize={(width, height) => {
            if (width <= 0 || height <= 0 || !Number.isFinite(width + height)) return;
            setHoverPreview((current) => {
              if (!current || current.fileId !== hoverFile.id) return current;
              const scale = Math.min(1, current.maxWidth / width, current.maxHeight / height);
              const fittedHeight = height * scale;
              return { ...current, width: width * scale, height: fittedHeight,
                top: current.side === "above" ? current.top + current.height - fittedHeight : current.top };
            });
          }} />
        </aside>, document.body,
      )}
    </main>
  );
}
