import { useEffect, useRef, useState } from "react";
import { CATEGORIES, type FileAction, type JianyingFileProtection, type JianyingSnapshot, type LocalAiClassificationResult } from "../shared/contracts";
import { Icon } from "./Icon";
import { FilePreview, isOperable, kindIcons, kindLabels, statusClass } from "./file-presentation";
import type { AppPage } from "./recent-page";
import type { Category, FileItem } from "./types";

type LocationChoice = "recommended" | "current";
const categories = [...CATEGORIES];
const locationOptions: Record<LocationChoice, { label: string; folder: string }> = {
  recommended: { label: "采用建议位置", folder: "" },
  current: { label: "保持当前位置", folder: "" },
};

function locationFor(file: FileItem, choice: LocationChoice): string {
  return choice === "current" ? file.parentDirectory : file.suggestedFolder;
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

function associatedProjectNames(protection: JianyingFileProtection): string {
  const names = [...new Set(protection.references.map((reference) => reference.project).filter(Boolean))];
  return names.length ? names.slice(0, 2).map((name) => `「${name}」`).join("、") : "剪映草稿";
}

function protectionSummary(protection: JianyingFileProtection): { title: string; body: string } {
  if (protection.level === "current") {
    return {
      title: "正在使用，已保持原位",
      body: `${associatedProjectNames(protection)} 正在使用这个文件，Sorttie 不会移动它。`,
    };
  }
  return {
    title: "曾被使用，已保持原位",
    body: `在 ${associatedProjectNames(protection)} 的历史备份中发现了这个文件。`,
  };
}

export function DetailPanel({ page, files, file, category, folder, open, onCategoryChange, onFolderChange, onFileAction, onClose, favorite, favoriteBusy, onToggleFavorite }: {
  page: AppPage;
  files: FileItem[];
  file: FileItem | undefined;
  category: Category | undefined;
  folder: string | undefined;
  open: boolean;
  onCategoryChange: (id: string, category: Category) => void;
  onFolderChange: (id: string, folder: string) => void;
  onFileAction: (action: FileAction, fileId: string) => void;
  onClose: () => void;
  favorite: boolean;
  favoriteBusy: boolean;
  onToggleFavorite: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"preview" | "info" | "source">("preview");
  const [draftCategory, setDraftCategory] = useState<Category>(category ?? "其他");
  const [locationChoice, setLocationChoice] = useState<LocationChoice>("recommended");
  const [toast, setToast] = useState("");
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [protectionEvidenceOpen, setProtectionEvidenceOpen] = useState(false);
  const [protection, setProtection] = useState<JianyingSnapshot | null>(null);
  const [protectionError, setProtectionError] = useState("");
  const [protectionBusy, setProtectionBusy] = useState(false);
  const [localAiResult, setLocalAiResult] = useState<LocalAiClassificationResult | null>(null);
  const [localAiBusy, setLocalAiBusy] = useState(false);
  const localAiGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    setProtection(null); setProtectionError("");
    if (file) void window.sorttie?.getJianyingProtection().then((value) => { if (active) setProtection(value); }).catch(() => { if (active) setProtectionError("剪映关联读取失败"); });
    return () => { active = false; };
  }, [file?.id]);
  const associated = protection?.files.find((item) => item.fileId === file?.id);
  const refreshProtection = async (choose: boolean) => {
    const api = window.sorttie;
    if (!api) { setProtectionError("无法连接本地服务"); return; }
    setProtectionBusy(true); setProtectionError("");
    try { setProtection(await (choose ? api.chooseJianyingDirectory() : api.getJianyingProtection())); }
    catch { setProtectionError("无法读取剪映草稿，请检查目录后重试"); }
    finally { setProtectionBusy(false); }
  };

  useEffect(() => {
    setEditing(false);
    setDraftCategory(category ?? "其他");
    setLocationChoice("recommended");
    setToast("");
    setTimelineExpanded(false);
    setProtectionEvidenceOpen(false);
    localAiGeneration.current += 1;
    setLocalAiResult(null);
    setLocalAiBusy(false);
    setTab("preview");
  }, [file?.id, category]);

  const classifyWithLocalAi = async () => {
    const api = window.sorttie;
    if (!api || !file || localAiBusy) return;
    const generation = ++localAiGeneration.current;
    setLocalAiBusy(true);
    setLocalAiResult(null);
    try {
      const result = await api.classifyFileWithLocalAi(file.id);
      if (generation === localAiGeneration.current) setLocalAiResult(result);
    } catch {
      if (generation === localAiGeneration.current) {
        setLocalAiResult({ status: "failed", fileId: file.id, model: null, code: "ipc_failed", message: "无法连接本地分析服务，请稍后重试。" });
      }
    } finally {
      if (generation === localAiGeneration.current) setLocalAiBusy(false);
    }
  };

  if (!file) {
    const operableCount = files.filter(isOperable).length;
    const unavailableCount = files.length - operableCount;
    const riskCount = files.filter((item) => item.status === "conflict").length;
    return (
      <aside className={`detail-panel detail-summary${open ? " is-open" : ""}`} data-testid="detail-panel" data-page={page}>
        <div className="detail-empty-icon"><Icon name="info" /></div>
        <h2>{page === "pending" ? "待整理页面摘要" : `今天发现 ${files.length} 个文件`}</h2>
        <p>{page === "pending" ? "进入管理后选择本次需要整理的文件。" : "选择一个文件，查看它的基本信息、可验证活动和整理建议。"}</p>
        <dl className="batch-summary">
          <div><dt>可整理</dt><dd>{operableCount}</dd></div>
          <div><dt>暂不可操作</dt><dd>{unavailableCount}</dd></div>
          <div><dt>风险项</dt><dd>{riskCount}</dd></div>
        </dl>
      </aside>
    );
  }

  const save = () => {
    onCategoryChange(file.id, draftCategory);
    const selectedFolder = locationFor(file, locationChoice);
    onFolderChange(file.id, selectedFolder);
    setEditing(false);
    setToast("整理信息已在本次演示中更新");
  };

  return (
    <aside className={`detail-panel${page === "recent" ? " recent-detail-panel" : ""}${open ? " is-open" : ""}`} data-testid="detail-panel">
      <header className="detail-header">
        <div><span className="eyebrow">文件详情</span><strong title={file.name} data-testid="detail-file-name">{file.name}</strong></div>
        <button type="button" className="icon-button drawer-close" aria-label="关闭详情" onClick={onClose}><Icon name="back" /></button>
      </header>
      <div className="detail-scroll" data-testid="detail-scroll">
        {!editing && <div className="detail-tabs" role="tablist" aria-label="文件详情分区">
          {(["preview", "info", "source"] as const).map((value, index) => <button type="button" key={value} id={`detail-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="detail-tab-content" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
            setTab((["preview", "info", "source"] as const)[next]);
            (event.currentTarget.parentElement!.children[next] as HTMLButtonElement).focus();
          }}>{["预览", "信息", "来源"][index]}</button>)}
        </div>}
        <div id="detail-tab-content" role={editing ? undefined : "tabpanel"} aria-labelledby={editing ? undefined : `detail-tab-${tab}`}>
        {!editing && (tab === "source" || associated?.level === "current" || associated?.level === "backup") && <section className="detail-section jianying-card" data-testid="jianying-detail">
          <div className="section-heading"><h3>剪映保护</h3><button type="button" className="text-button" disabled={protectionBusy} onClick={() => { void refreshProtection(!protection?.root); }}>{protectionBusy ? "检查中…" : protection?.root ? "重新检查" : "连接草稿目录"}</button></div>
          {protection?.root && associated?.references.length ? (() => {
            const copy = protectionSummary(associated);
            return <>
              <div className={`jianying-status is-${associated.level}`}>
                <span><Icon name="shield" /></span>
                <div><strong>{copy.title}</strong><p>{copy.body}</p></div>
              </div>
              <button type="button" className="text-button jianying-evidence-toggle" onClick={() => setProtectionEvidenceOpen((value) => !value)}>{protectionEvidenceOpen ? "收起依据" : "查看依据"}</button>
              {protectionEvidenceOpen && <div className="jianying-evidence">
                {associated.references.slice(0, 3).map((reference, index) => (
                  <div key={`${reference.project}-${reference.revision}-${index}`}>
                    <strong>{reference.project}</strong>
                    <small>{reference.kind === "current" ? "当前时间线" : "历史备份"} · {formatEvidenceDate(reference.observedAt)}</small>
                  </div>
                ))}
                {protection.incomplete > 0 && <p>另有部分草稿暂时无法读取，以上结果仅基于已发现的引用。</p>}
              </div>}
              {tab === "source" && <button type="button" className="text-button" disabled={protectionBusy} onClick={() => { void refreshProtection(true); }}>更换草稿目录</button>}
            </>;
          })() : protection?.root ? <>
            <p className="jianying-muted">暂未发现剪映项目使用此文件。开始整理前会再次检查。</p>
            {tab === "source" && <button type="button" className="text-button" disabled={protectionBusy} onClick={() => { void refreshProtection(true); }}>更换草稿目录</button>}
          </> : null}
          {!protection?.root && !protectionError && <p className="jianying-muted">选择剪映草稿目录后，Sorttie 会在整理前检查素材引用。</p>}
          {protectionError && <p className="jianying-muted" role="status">{protectionError}</p>}
        </section>}
        {!editing && tab === "preview" && <>
        <FilePreview file={file} compact />
        <div className="detail-preview-meta"><span>{file.size}</span><span>{file.modified}</span></div>
        <div className="quick-actions" aria-label="文件快捷操作">
          <button type="button" onClick={() => onFileAction("open", file.id)}><Icon name="open" /><span>打开文件</span></button>
          <button type="button" onClick={() => onFileAction("show-in-folder", file.id)}><Icon name="folder" /><span>所在位置</span></button>
          <button type="button" aria-pressed={favorite} disabled={favoriteBusy} onClick={() => onToggleFavorite(file.id)}><Icon name="star" fill={favorite ? "currentColor" : "none"} /><span>{favorite ? "取消收藏" : "收藏"}</span></button>
        </div>
        {toast && <div className="inline-toast" role="status">{toast}</div>}
        <section className="detail-section preview-destination"><h3>建议整理至</h3><p title={folder}><Icon name="folder" /><span>{folder}</span></p></section>
        <section className="detail-section preview-activity"><h3>最近活动</h3><p>{file.activity[0]?.action ?? "首次发现"}</p><small title={file.parentDirectory}>{file.parentDirectory}</small></section>
        </>}

        {!editing ? (
          <>
            <section className="detail-section info-grid" hidden={tab !== "info"}>
              <h3>基本信息</h3>
              <dl>
                <div><dt>类型</dt><dd>{kindLabels[file.kind]} · {file.extension}</dd></div>
                <div><dt>大小</dt><dd>{file.size}</dd></div>
                <div><dt>修改时间</dt><dd>{file.modified}</dd></div>
                <div><dt>当前位置</dt><dd title={file.path}>{file.path}</dd></div>
              </dl>
            </section>
            <section className="detail-section" hidden={tab !== "info"}>
              <div className="section-heading"><h3>整理信息</h3><button type="button" className="text-button" onClick={() => setEditing(true)} data-testid="edit-detail"><Icon name="edit" />编辑</button></div>
              <dl className="organize-readout">
                <div><dt>分类</dt><dd><Icon name={kindIcons[file.kind]} />{category}</dd></div>
                <div><dt>建议位置</dt><dd title={folder}><Icon name="location" />{folder}</dd></div>
              </dl>
              {category === "其他" && <>
                <button type="button" className="text-button" disabled={localAiBusy} onClick={() => { void classifyWithLocalAi(); }} data-testid="local-ai-classify">
                  <Icon name="spark" />{localAiBusy ? "本地分析中…" : localAiResult ? "重新分析" : "让 Gemma 判断"}
                </button>
                {localAiResult && <div className="jianying-status" data-testid="local-ai-result" role="status">
                  <span><Icon name="spark" /></span>
                  <div>
                    {localAiResult.status === "ready" ? <>
                      <strong>{localAiResult.category === "其他" ? "暂时无法确定分类" : `建议归为“${localAiResult.category}”`}</strong>
                      <p>{localAiResult.reason}</p>
                      {localAiResult.category !== "其他" && <button type="button" className="text-button" onClick={() => onCategoryChange(file.id, localAiResult.category)}>采用建议</button>}
                    </> : <>
                      <strong>本地分析暂不可用</strong>
                      <p>{localAiResult.message}</p>
                    </>}
                  </div>
                </div>}
              </>}
            </section>
            {file.status === "conflict" && (
              <div className="risk-note"><Icon name="warning" /><span><strong>目标位置存在同名文件</strong><small>开始整理前需要选择保留方式。</small></span></div>
            )}
            <section className="detail-section timeline-section" hidden={tab !== "source"}>
              <div className="section-heading">
                <h3>来源轨迹</h3>
                {page === "recent" && file.activity.length > 2 && <button type="button" className="text-button" onClick={() => setTimelineExpanded((current) => !current)}>{timelineExpanded ? "收起" : "查看全部"}</button>}
              </div>
              <ol className="timeline">
                {file.activity.slice(0, page === "recent" && !timelineExpanded ? 2 : 3).map((activity, index) => (
                  <li className={!activity.verified ? "unverified" : ""} key={`${activity.action}-${index}`}>
                    <i /><div><strong>{activity.action}</strong><span>{activity.time}</span><small title={activity.location}>{activity.location}</small></div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        ) : (
          <div className="edit-panel" data-testid="edit-panel">
            <div className="edit-intro"><h3>编辑整理信息</h3><p>仅保存在当前会话中，不会操作文件。</p></div>
            <fieldset>
              <legend>分类</legend>
              <div className="category-grid">
                {categories.map((item) => (
                  <button
                    type="button"
                    className={draftCategory === item ? "is-selected" : ""}
                    aria-pressed={draftCategory === item}
                    key={item}
                    onClick={() => setDraftCategory(item)}
                  >
                    <Icon name={item === "图片" ? "image" : item === "视频" ? "video" : item === "音频" ? "audio" : item === "压缩包" ? "archive" : item === "代码与数据" ? "code" : "file"} />
                    <span>{item}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>建议位置</legend>
              <p className="path-preview" title={locationFor(file, locationChoice)}>
                <Icon name="folder" />
                <span>{locationFor(file, locationChoice)}</span>
              </p>
              <div className="location-options">
                {(Object.keys(locationOptions) as LocationChoice[]).map((choice) => (
                  <button type="button" key={choice} className={locationChoice === choice ? "is-selected" : ""} onClick={() => setLocationChoice(choice)}>
                    <span className="radio-dot" />{locationOptions[choice].label}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        )}
        </div>
      </div>
      <footer className="detail-footer" data-testid="detail-footer">
        {editing ? (
          <><button type="button" className="secondary-button" onClick={() => { setEditing(false); setDraftCategory(category ?? file.category); }}>取消</button><button type="button" className="primary-button" onClick={save}>保存</button></>
        ) : (
          <button type="button" className="secondary-button detail-edit-entry" onClick={() => setEditing(true)}>编辑整理信息</button>
        )}
      </footer>
    </aside>
  );
}
