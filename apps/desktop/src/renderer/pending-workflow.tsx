import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  CATEGORIES,
  type JianyingFileProtection,
  type JianyingSnapshot,
  type OrganizationActionResult,
  type OrganizationPreparationResult,
  type OrganizationDestinationMode,
  type WatchDirectoryState,
} from "../shared/contracts";
import { Icon } from "./Icon";
import { isOperable, kindIcons, statusClass } from "./file-presentation";
import { DirectoryState } from "./recent-page";
import type { Category, FileItem } from "./types";

const categories = [...CATEGORIES];
const categoryIcons: Record<Category, Parameters<typeof Icon>[0]["name"]> = {
  图片: "image",
  视频: "video",
  音频: "audio",
  文档: "file",
  "代码与数据": "code",
  压缩包: "archive",
  其他: "file",
};

type BatchItemResult = Readonly<{
  file: FileItem;
  operationId: string;
  destinationPath: string;
  result: OrganizationActionResult;
}>;

type ProtectionEntry = Readonly<{
  file: FileItem;
  protection: JianyingFileProtection;
  excluded: boolean;
}>;

type PopoverProps = {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

function FilterPopover({ id, label, value, options, onChange }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const width = 184;
      const expectedHeight = Math.min(options.length * 38 + 12, 250);
      const top = rect.bottom + expectedHeight + 8 <= window.innerHeight
        ? rect.bottom + 6
        : Math.max(8, rect.top - expectedHeight - 6);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      setPosition({ top, left });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOutside = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOutside);
    };
  }, [open]);

  return (
    <div className="filter-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-button${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${id}-trigger`}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}: {value}</span><Icon name="chevron" />
      </button>
      {open && (
        <div
          className="filter-popover"
          role="listbox"
          aria-label={label}
          data-testid={`${id}-popover`}
          style={position}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option === value}
              className={option === value ? "is-selected" : ""}
              key={option}
              onClick={() => { onChange(option); setOpen(false); }}
            >
              <span>{option}</span>{option === value && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionControl({ checked, partial = false, disabled = false, disabledReason, label, onClick, testId }: {
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`selection-control${checked ? " is-checked" : ""}${partial ? " is-partial" : ""}`}
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? disabledReason ?? "此文件暂不可整理" : label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      {checked && <Icon name="check" />}
      {!checked && partial && <span />}
    </button>
  );
}

function formatEvidenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function protectionEntryCopy(entry: ProtectionEntry): string {
  if (!entry.excluded) return "已选择继续整理";
  if (entry.protection.level === "current") return "正在被剪映项目使用，保持原位";
  return "曾在剪映项目中使用，保持原位";
}

export function PendingPage({ files, onOpenFile, onContext, onDragStart, managementMode, onManagementChange, managedFileIds, setManagedFileIds, onPreview, watchState, onChoose, onRescan }: {
  files: FileItem[];
  onOpenFile: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  onDragStart: (id: string, event: DragEvent<HTMLElement>) => void;
  managementMode: boolean;
  onManagementChange: (enabled: boolean) => void;
  managedFileIds: Set<string>;
  setManagedFileIds: (next: Set<string>) => void;
  onPreview: () => void;
  watchState: WatchDirectoryState;
  onChoose: () => void;
  onRescan: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState("全部");
  const visible = statusFilter === "全部" ? files : files.filter((file) => file.statusLabel === statusFilter);
  const selectable = visible.filter(isOperable);
  const allSelected = selectable.length > 0 && selectable.every((file) => managedFileIds.has(file.id));
  const someSelected = !allSelected && selectable.some((file) => managedFileIds.has(file.id));
  const toggleAll = () => {
    const next = new Set(managedFileIds);
    if (allSelected) selectable.forEach((file) => next.delete(file.id));
    else selectable.forEach((file) => next.add(file.id));
    setManagedFileIds(next);
  };
  const toggleOne = (id: string) => {
    const next = new Set(managedFileIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setManagedFileIds(next);
  };
  const disabledReason = (file: FileItem) => file.unavailableReason ?? "此文件暂不可整理";

  return (
    <main className="workspace pending-workspace" data-testid="workspace">
      <header className="workspace-header" data-testid="workspace-header">
        <div><span className="eyebrow">批量审核</span><h1>待整理</h1><p title={watchState.directory ?? undefined}>{watchState.directory ?? "尚未连接监控位置"} · 进入管理后选择本次需要整理的文件。</p></div>
        <div className="toolbar">
          <FilterPopover id="status-filter" label="状态" value={statusFilter} options={["全部", "可整理", "已修改分类", "存在冲突", "下载中", "受保护"]} onChange={setStatusFilter} />
          <button
            type="button"
            className={`management-button${managementMode ? " is-active" : ""}`}
            disabled={files.length === 0 || watchState.phase === "scanning"}
            data-testid="management-toggle"
            onClick={() => onManagementChange(!managementMode)}
          >
            {managementMode ? "完成" : "管理"}
          </button>
        </div>
      </header>
      <div className="workspace-body pending-body">
        {files.length === 0 || ["unconfigured", "inaccessible", "error"].includes(watchState.phase) ? <DirectoryState page="pending" state={watchState} onChoose={onChoose} onRetry={onRescan} /> : visible.length === 0 ? (
          <div className="filter-empty"><Icon name="search" /><strong>没有符合当前筛选的文件</strong><span>更改状态筛选后再查看。</span></div>
        ) : (
          <div className={`pending-list${managementMode ? " is-managing" : ""}`} data-testid="pending-list">
            <div className="pending-list-head">
              {managementMode && <SelectionControl checked={allSelected} partial={someSelected} onClick={toggleAll} label={allSelected ? "取消全选" : "全选可操作文件"} testId="select-all" />}
              <span>文件</span><span>分类</span><span>大小</span><span>修改时间</span><span>状态</span>
            </div>
            {visible.map((file) => (
              <div
                className="pending-row"
                key={file.id}
                onClick={(event) => {
                  if (managementMode && event.detail === 1) {
                    if (isOperable(file)) toggleOne(file.id);
                  }
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  if (!managementMode) onOpenFile(file.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onContext(file.id, event.clientX, event.clientY);
                }}
                draggable
                onDragStart={(event) => onDragStart(file.id, event)}
                data-testid={`pending-row-${file.id}`}
              >
                {managementMode && <SelectionControl checked={managedFileIds.has(file.id)} disabled={!isOperable(file)} disabledReason={disabledReason(file)} onClick={() => toggleOne(file.id)} label={`选择 ${file.name}`} />}
                <span className="pending-file"><span className={`mini-kind kind-${file.kind}`}><Icon name={kindIcons[file.kind]} /></span><span><strong title={file.name}>{file.name}</strong><small>{file.extension}</small></span></span>
                <span>{file.category}</span><span className="pending-meta">{file.size}</span><span className="pending-meta">{file.modified}</span><span className={`row-status ${statusClass[file.status]}`}><i />{file.statusLabel}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {managementMode && managedFileIds.size > 0 && (
        <div className="batch-bar" data-testid="batch-bar">
          <span><strong>已选 {managedFileIds.size} 项</strong><small>生成冻结整理计划，确认后移动文件</small></span>
          <button type="button" className="text-button" onClick={() => setManagedFileIds(new Set())}>取消选择</button>
          <button type="button" className="primary-button" onClick={onPreview}>整理 {managedFileIds.size} 项</button>
        </div>
      )}
    </main>
  );
}

export function OrganizationPreview({ files, categoriesById, foldersById, onClose }: {
  files: FileItem[];
  categoriesById: Record<string, Category>;
  foldersById: Record<string, string>;
  onClose: () => void;
}) {
  const [planFiles] = useState(files);
  const [protection, setProtection] = useState<JianyingSnapshot | null>(null);
  const [confirmedReferences, setConfirmedReferences] = useState<Record<string, string>>({});
  const protectedFile = (id: string) => protection?.files.find((item) => item.fileId === id);
  const excludedByProtection = (id: string) => {
    const item = protectedFile(id);
    return item?.level === "current" || (item?.level === "backup" && confirmedReferences[id] !== item.confirmation);
  };
  const [detailed, setDetailed] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [expandedConflictId, setExpandedConflictId] = useState<string | null>(null);
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<OrganizationPreparationResult | null>(null);
  const [executionResults, setExecutionResults] = useState<readonly BatchItemResult[]>([]);
  const [undoResults, setUndoResults] = useState<Record<string, OrganizationActionResult>>({});
  const [executionStarted, setExecutionStarted] = useState(false);
  const [undoStarted, setUndoStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [organizationRoot, setOrganizationRoot] = useState<string | null>(null);
  const [destinationMode, setDestinationMode] = useState<OrganizationDestinationMode>("categorized");
  const [protectionEvidenceOpen, setProtectionEvidenceOpen] = useState(false);
  const [loadingRoot, setLoadingRoot] = useState(true);
  const busyRef = useRef(false);
  const conflicts = planFiles.filter((file) => file.status === "conflict");
  const pendingDestination = destinationMode === "same-location" ? [] : planFiles.filter((file) => (categoriesById[file.id] ?? file.category) === "其他");
  const ordinary = planFiles.filter((file) => file.status !== "conflict" && !pendingDestination.includes(file) && !excludedByProtection(file.id));
  const protectionEntries = planFiles.reduce<ProtectionEntry[]>((result, file) => {
    const item = protectedFile(file.id);
    if (item && item.level !== "none") result.push({ file, protection: item, excluded: excludedByProtection(file.id) });
    return result;
  }, []);
  const protectedSkippedCount = protectionEntries.filter((entry) => entry.excluded).length;
  const acceptedRiskCount = protectionEntries.length - protectedSkippedCount;
  const prepared = preparation?.status === "prepared" ? preparation : null;
  const preparedItemFor = (fileId: string) => prepared?.items.find((item) => item.fileId === fileId);
  const folderFor = (file: FileItem) => {
    const frozenPath = preparedItemFor(file.id)?.destinationPath;
    if (frozenPath) return frozenPath.slice(0, Math.max(frozenPath.lastIndexOf("\\"), frozenPath.lastIndexOf("/")));
    if (organizationRoot) return `${organizationRoot.replace(/[\\/]+$/, "")}\\${categoriesById[file.id] ?? file.category}`;
    return `待选择整理根目录 · ${categoriesById[file.id] ?? file.category}`;
  };
  const groups = ordinary.reduce<Record<string, FileItem[]>>((result, file) => {
    const folder = folderFor(file);
    (result[folder] ??= []).push(file);
    return result;
  }, {});
  const categoryCounts = planFiles.filter((file) => !pendingDestination.includes(file) && !excludedByProtection(file.id)).reduce<Record<string, number>>((result, file) => {
    const category = categoriesById[file.id] ?? file.category;
    result[category] = (result[category] ?? 0) + 1;
    return result;
  }, {});
  const successfulMoves = executionResults.filter((item) => item.result.status === "moved");
  const failedMoves = executionResults.filter((item) => item.result.status !== "moved");
  const undoCandidates = successfulMoves.filter((item) => undoResults[item.operationId]?.status !== "undone");
  const undoneCount = successfulMoves.filter((item) => undoResults[item.operationId]?.status === "undone").length;
  const undoFailureCount = Object.values(undoResults).filter((result) => result.status !== "undone").length;
  const visibleFailureCount = undoStarted ? undoFailureCount : failedMoves.length;
  const dialogTitle = executionStarted ? (undoStarted ? "撤销结果" : "整理结果") : "整理预览";

  const prepare = async (mode: OrganizationDestinationMode = "categorized") => {
    if (busyRef.current || planFiles.length === 0) return;
    const api = window.sorttie;
    if (!api) {
      setNotice("无法连接本地文件服务，请重新启动 Sorttie。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    try {
      const fresh = await api.getJianyingProtection();
      setProtection(fresh);
      const result = await api.prepareOrganizationPlan(planFiles.map((file) => ({
        fileId: file.id,
        category: categoriesById[file.id] ?? file.category,
        ...(confirmedReferences[file.id] ? { protectionConfirmation: confirmedReferences[file.id] } : {}),
      })), mode);
      if (result.status !== "cancelled") setPreparation(result);
      if (result.status === "prepared") {
        setDestinationMode(mode);
        if (mode !== "same-location") setOrganizationRoot(result.destinationDirectory);
      }
      setNotice(result.status === "prepared" ? "" : result.message);
    } catch {
      setNotice("无法确认整理位置，文件未移动。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    const api = window.sorttie;
    if (!api) { setLoadingRoot(false); setNotice("无法连接本地服务"); return; }
    void Promise.all([api.getOrganizationRoot(), api.getJianyingProtection()]).then(([root, snapshot]) => {
      if (!active) return;
      setProtection(snapshot);
      setOrganizationRoot(root);
      setLoadingRoot(false);
      if (root) void prepare();
    }).catch(() => {
      if (active) { setLoadingRoot(false); setNotice("无法读取整理配置或剪映关联，请重新检查。"); }
    });
    return () => { active = false; };
  }, []);

  const execute = async () => {
    if (busyRef.current || !prepared || executionStarted) return;
    const api = window.sorttie;
    if (!api) {
      setNotice("无法连接本地文件服务，文件未移动。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setExecutionStarted(true);
    setExecutionResults([]);
    setUndoResults({});
    setUndoStarted(false);
    setNotice("");
    try {
      const completed: BatchItemResult[] = [];
      for (const item of prepared.items) {
        const file = planFiles.find((candidate) => candidate.id === item.fileId);
        if (!file) continue;
        let result: OrganizationActionResult;
        try {
          result = await api.executeOrganization(item.operationId);
        } catch {
          result = {
            status: "failed",
            operationId: item.operationId,
            code: "request_failed",
            message: "整理请求失败，文件未移动。",
          };
        }
        completed.push({ file, operationId: item.operationId, destinationPath: item.destinationPath, result });
        setExecutionResults([...completed]);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const undo = async () => {
    if (busyRef.current || undoCandidates.length === 0) return;
    const api = window.sorttie;
    if (!api) {
      setNotice("无法连接本地文件服务，未执行撤销。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setUndoStarted(true);
    setNotice("");
    try {
      const next = { ...undoResults };
      for (const item of [...undoCandidates].reverse()) {
        try {
          next[item.operationId] = await api.undoOrganization(item.operationId);
        } catch {
          next[item.operationId] = {
            status: "failed",
            operationId: item.operationId,
            code: "request_failed",
            message: "撤销请求失败，请检查文件当前位置。",
          };
        }
        setUndoResults({ ...next });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const footerMessage = notice
    || (executionStarted
      ? undoStarted
        ? undoFailureCount > 0
          ? `已撤销 ${undoneCount} 项，失败 ${undoFailureCount} 项`
          : `已撤销 ${undoneCount} 项`
        : busy
          ? `正在整理 ${executionResults.length}/${prepared?.items.length ?? planFiles.length} 项`
          : failedMoves.length > 0
            ? `成功 ${successfulMoves.length} 项，失败 ${failedMoves.length} 项`
            : `成功 ${successfulMoves.length} 项`
      : conflicts.length
      ? `还有 ${conflicts.length} 项冲突需要处理`
      : prepared
          ? `${prepared.items.length} 项将整理${protectedSkippedCount > 0 ? `，${protectedSkippedCount} 项保持原位` : ""}${pendingDestination.length > 0 ? `，${pendingDestination.length} 项等待确认去向` : ""}`
          : "请先确认目标文件夹");

  return (
    <div className="modal-layer" role="presentation">
      <section className="plan-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-title" data-testid="plan-dialog">
        <header className="plan-header">
          <div><button type="button" className="back-button" disabled={busy} onClick={onClose}><Icon name="back" />返回</button><h2 id="plan-title">{dialogTitle}</h2></div>
          <button type="button" className="icon-button" aria-label={`关闭${dialogTitle}`} disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="plan-scroll" data-testid="plan-scroll">
          {!executionStarted && <div className="section-heading">
            <div><h3>{destinationMode === "same-location" ? "全部放到同一位置" : "整理根目录"}</h3><p title={prepared?.destinationDirectory ?? organizationRoot ?? undefined}>{prepared?.destinationDirectory ?? organizationRoot ?? "选择一次，后续按分类生成去向"}</p></div>
            <div><button type="button" className="text-button" disabled={busy || loadingRoot} onClick={() => { void prepare("choose-root"); }}>更改根目录</button><button type="button" className="text-button" disabled={busy || loadingRoot} onClick={() => { void prepare("same-location"); }}>全部放到同一位置</button></div>
          </div>}
          {pendingDestination.length > 0 && <section className="destination-groups" aria-label="等待确认去向">
            <div className="section-heading"><div><h3>{pendingDestination.length} 项等待确认去向</h3><p>保持原位；返回调整分类，或明确选择统一位置。</p></div></div>
            {pendingDestination.map((file) => <div key={file.id} className="group-files"><div><span className="mini-kind"><Icon name="file" /></span><span><strong title={file.name}>{file.name}</strong><small>等待确认去向 · 未移动</small></span></div></div>)}
          </section>}
          {executionStarted ? (
            <>
            <section className="plan-hero" role="status">
              <span className="plan-hero-icon"><Icon name={busy ? "clock" : failedMoves.length > 0 || undoFailureCount > 0 ? "warning" : "check"} /></span>
              <div>
                <h3>{busy ? (undoStarted ? "正在撤销" : "正在整理") : undoStarted ? "批量撤销完成" : "批量整理完成"}</h3>
                <strong>{undoStarted ? `已撤销 ${undoneCount} 项` : `成功 ${successfulMoves.length} 项`}</strong>
                <p>{undoStarted
                  ? undoFailureCount > 0
                    ? `失败 ${undoFailureCount} 项；其余整理结果保持不变。`
                    : "所有已整理文件均已恢复到原位置。"
                  : failedMoves.length > 0
                    ? `失败 ${failedMoves.length} 项；可展开查看每个文件。`
                    : "计划内文件整理成功，可逐项查看位置。"}</p>
              </div>
              {visibleFailureCount > 0 && <div className="attention-count has-risk"><strong>{visibleFailureCount}</strong><span>项失败</span></div>}
            </section>
            <section className="destination-groups" data-testid="batch-results" aria-label="逐项整理结果">
              <div className="section-heading"><div><h3>逐项结果</h3><p>点击文件查看原因</p></div></div>
              {(prepared?.items ?? []).map((item) => {
                const file = planFiles.find((candidate) => candidate.id === item.fileId);
                if (!file) return null;
                const execution = executionResults.find((candidate) => candidate.operationId === item.operationId);
                const undoResult = undoResults[item.operationId];
                const result = undoResult ?? execution?.result;
                const label = result ? resultLabel(result, undoResult !== undefined) : "等待执行";
                const displayedLocation = undoResult?.status === "undone"
                  ? `已恢复至：${file.path}`
                  : execution?.result.status === "moved"
                    ? `已整理至：${item.destinationPath}`
                    : `原位置：${file.path}`;
                const expanded = expandedResultId === item.operationId;
                return (
                  <article className={`destination-group${expanded ? " is-expanded" : ""}`} key={item.operationId}>
                    <button type="button" className="group-summary" aria-expanded={expanded} onClick={() => setExpandedResultId(expanded ? null : item.operationId)}>
                      <span className={`mini-kind kind-${file.kind}`}><Icon name={kindIcons[file.kind]} /></span>
                      <span><strong title={file.name}>{file.name}</strong><small title={displayedLocation}>{displayedLocation}</small></span>
                      <b>{label}</b><Icon name="chevron" />
                    </button>
                    {expanded && <div className="group-files"><div><span className={`mini-kind kind-${file.kind}`}><Icon name={kindIcons[file.kind]} /></span><span><strong>{label}</strong><small>{result?.message ?? "等待前一项处理完成。"}</small></span></div></div>}
                  </article>
                );
              })}
            </section>
            </>
          ) : <>
          <section className="plan-hero">
            <span className="plan-hero-icon"><Icon name="spark" /></span>
              <div><span>准备整理</span><strong>{prepared?.items.length ?? planFiles.filter((file) => !pendingDestination.includes(file) && !excludedByProtection(file.id)).length} 项</strong><p>同盘移动 · 缺失分类目录将在执行时创建</p></div>
            <div className="plan-counts" aria-label="文件类型统计">
              {categories.filter((category) => categoryCounts[category] > 0).map((category) => (
                <span key={category} role="img" aria-label={`${category}，${categoryCounts[category]} 项`} title={`${category}，${categoryCounts[category]} 项`}>
                  <Icon name={categoryIcons[category]} /><b>{categoryCounts[category]}</b>
                </span>
              ))}
            </div>
            {conflicts.length > 0 && <div className="attention-count has-risk"><strong>{conflicts.length}</strong><span>项冲突需处理</span></div>}
          </section>
          {protection?.root && protectionEntries.length > 0 && <section className="protection-review" data-testid="jianying-review">
            <header>
              <span className="protection-mark"><Icon name="shield" /></span>
              <div>
                <h3>{protectedSkippedCount > 0 ? `${protectedSkippedCount} 项剪映素材保持原位` : `${acceptedRiskCount} 项继续整理`}</h3>
                <p>{protectedSkippedCount > 0 ? `Sorttie 不会移动这些文件，其余 ${prepared?.items.length ?? ordinary.length} 项可以继续整理。` : "开始整理前，Sorttie 会再次检查这些文件。"}</p>
              </div>
              <button type="button" className="text-button" onClick={() => setProtectionEvidenceOpen((value) => !value)}>{protectionEvidenceOpen ? "收起依据" : "查看依据"}</button>
            </header>
            {acceptedRiskCount > 0 && <p className="protection-note">{acceptedRiskCount} 项已改为继续整理。</p>}
            {protectionEvidenceOpen && <div className="protection-evidence-list">
              {protection.incomplete > 0 && <p className="protection-note">另有部分草稿暂时无法读取，以下结果仅基于已发现的引用。</p>}
              {protectionEntries.map((entry) => (
                <article className="protection-evidence-item" key={entry.file.id}>
                  <span className={`mini-kind kind-${entry.file.kind}`}><Icon name={kindIcons[entry.file.kind]} /></span>
                  <div>
                    <strong title={entry.file.name}>{entry.file.name}</strong>
                    <small>{protectionEntryCopy(entry)}</small>
                    {entry.protection.references.slice(0, 2).map((reference, index) => (
                      <em key={`${reference.project}-${reference.revision}-${index}`}>
                        {reference.project} · {reference.kind === "current" ? "当前时间线" : "历史备份"} · {formatEvidenceDate(reference.observedAt)}
                      </em>
                    ))}
                  </div>
                  {entry.protection.level === "backup" && <button type="button" className="text-button" disabled={busy} onClick={() => {
                    setConfirmedReferences((current) => { const next = { ...current }; if (next[entry.file.id] === entry.protection.confirmation) delete next[entry.file.id]; else next[entry.file.id] = entry.protection.confirmation!; return next; });
                    setPreparation(null);
                  }}>{entry.excluded ? "继续整理" : "改为保留"}</button>}
                </article>
              ))}
            </div>}
          </section>}
          {conflicts.length > 0 && (
            <section className="conflict-area" data-testid="conflict-area">
              <header><span><Icon name="warning" /></span><div><h3>先处理同名冲突</h3><p>目标位置已有同名文件，确认方式前不会开始整理。</p></div></header>
              {conflicts.map((file) => (
                <div className="conflict-item" key={file.id}>
                  <button type="button" className="conflict-row" aria-expanded={expandedConflictId === file.id} onClick={() => setExpandedConflictId(expandedConflictId === file.id ? null : file.id)}>
                    <span className="mini-kind kind-video"><Icon name="video" /></span><span><strong title={file.name}>{file.name}</strong><small title={folderFor(file)}>{folderFor(file)}</small></span><span>选择处理方式<Icon name="chevron" /></span>
                  </button>
                  {expandedConflictId === file.id && <div className="conflict-detail"><strong>需要确认同名文件的处理方式</strong><span>当前版本不会覆盖目标位置已有的文件。</span></div>}
                </div>
              ))}
            </section>
          )}
          {!detailed ? (
            <section className="destination-groups" aria-label="按目标位置分组">
              <div className="section-heading"><div><h3>按去向查看</h3><p>点击一组可展开文件</p></div><button type="button" className="text-button" onClick={() => setDetailed(true)}>查看详细清单</button></div>
              {Object.entries(groups).map(([folder, groupFiles]) => {
                const expanded = expandedGroup === folder;
                return (
                  <article className={`destination-group${expanded ? " is-expanded" : ""}`} key={folder}>
                    <button type="button" className="group-summary" aria-expanded={expanded} onClick={() => setExpandedGroup(expanded ? null : folder)}>
                      <span className="group-icon"><Icon name="folder" /></span>
                      <span>
                        <strong title={folder}>{folder}</strong>
                        <small className="group-file-preview" title={groupFiles.slice(0, 2).map((file) => file.name).join(" · ")}>
                          {groupFiles.slice(0, 2).map((file) => file.name).join(" · ")}
                        </small>
                      </span>
                      <b>{groupFiles.length} 项</b><Icon name="chevron" />
                    </button>
                    {expanded && <div className="group-files">{groupFiles.map((file) => <div key={file.id}><span className={`mini-kind kind-${file.kind}`}><Icon name={kindIcons[file.kind]} /></span><span><strong>{file.name}</strong><small>{categoriesById[file.id] ?? file.category} · {file.size}</small></span></div>)}</div>}
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="detail-manifest">
              <div className="section-heading"><div><h3>详细清单</h3><p>用于核对完整路径</p></div><button type="button" className="text-button" onClick={() => setDetailed(false)}>返回分组</button></div>
              <div className="manifest-table" role="table">
                <div role="row"><span>文件</span><span>目标位置</span><span>状态</span></div>
                {ordinary.map((file) => <button type="button" role="row" key={file.id}><span title={file.path}>{file.name}</span><span title={preparedItemFor(file.id)?.destinationPath ?? folderFor(file)}>{preparedItemFor(file.id)?.destinationPath ?? folderFor(file)}</span><span className={statusClass[file.status]}>{file.statusLabel}</span></button>)}
              </div>
            </section>
          )}
          </>}
        </div>
        <footer className="plan-footer" data-testid="plan-footer">
          <span style={{ color: executionStarted && (failedMoves.length > 0 || undoFailureCount > 0) ? "var(--danger)" : "var(--muted)" }}>{footerMessage}</span>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{executionStarted ? "关闭" : "返回"}</button>
          {!executionStarted && (
            <button
              type="button"
              className="primary-button"
              data-testid={prepared ? "execute-organization" : "prepare-organization"}
              onClick={() => { void (prepared ? execute() : prepare()); }}
              disabled={busy || loadingRoot || conflicts.length > 0 || planFiles.length === pendingDestination.length}
              title={conflicts.length ? "请先处理冲突" : undefined}
            >
              {busy || loadingRoot ? "处理中…" : prepared ? "开始整理" : organizationRoot ? "生成整理方案" : "选择整理根目录"}
            </button>
          )}
          {executionStarted && undoCandidates.length > 0 && !busy && (
            <button type="button" className="primary-button" data-testid="undo-organization" disabled={busy} onClick={() => { void undo(); }}>
              {undoStarted ? `重试撤销 ${undoCandidates.length} 项` : `撤销已整理的 ${undoCandidates.length} 项`}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function resultLabel(result: OrganizationActionResult, isUndo: boolean): string {
  if (isUndo) return result.status === "undone" ? "已撤销" : "撤销失败";
  if (result.status === "moved") return "整理成功";
  if (result.code === "cross_volume_unsupported") return "暂不支持跨盘";
  if (result.status === "blocked") return "preflight 阻止";
  return "移动失败";
}
