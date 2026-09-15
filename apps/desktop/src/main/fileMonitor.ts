import chokidar, { type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Category,
  FileChangeEvent,
  FileActivityKind,
  FileKind,
  FileRecord,
  FileSnapshot,
  FileStatus,
  PreviewCapability,
  SnapshotReason,
  TextPreview,
  WatchDirectoryState,
} from "../shared/contracts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".ppt", ".pptx", ".xls", ".xlsx"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz"]);
const CODE_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".py", ".pyw", ".ipynb", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".go", ".rs", ".php", ".rb", ".swift", ".sh", ".ps1", ".bat", ".cmd", ".json", ".jsonl",
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".csv", ".tsv", ".log",
]);
const DOWNLOAD_EXTENSIONS = new Set([".crdownload", ".part", ".download", ".tmp"]);
const PROTECTED_NAMES = new Set(["desktop.ini", "thumbs.db"]);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".md", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx",
  ".mjs", ".cjs", ".vue", ".svelte", ".py", ".pyw", ".ipynb", ".java", ".kt", ".kts", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".swift", ".sh", ".ps1", ".bat", ".cmd", ".json",
  ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".csv", ".tsv", ".log",
]);

const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".pdf": "application/pdf",
};

const kindByCategory: Record<Category, FileKind> = {
  图片: "image",
  视频: "video",
  音频: "audio",
  文档: "document",
  "代码与数据": "code",
  压缩包: "archive",
  其他: "unknown",
};

export function classifyExtension(extension: string): Category {
  const normalized = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalized)) return "图片";
  if (VIDEO_EXTENSIONS.has(normalized)) return "视频";
  if (AUDIO_EXTENSIONS.has(normalized)) return "音频";
  if (DOCUMENT_EXTENSIONS.has(normalized)) return "文档";
  if (CODE_EXTENSIONS.has(normalized)) return "代码与数据";
  if (ARCHIVE_EXTENSIONS.has(normalized)) return "压缩包";
  return "其他";
}

export function previewCapabilityFor(extension: string, kind: FileKind): PreviewCapability {
  const normalized = extension.toLowerCase();
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (normalized === ".pdf") return "pdf";
  if (TEXT_PREVIEW_EXTENSIONS.has(normalized)) return "text";
  return "unsupported";
}

function normalizeForId(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

export function stableFileId(directory: string, relativeName: string): string {
  return createHash("sha256").update(`${normalizeForId(directory)}\0${relativeName.toLocaleLowerCase("en-US")}`).digest("hex");
}

function asIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function statusFor(name: string, extension: string, readable: boolean): { status: FileStatus; isOrganizable: boolean; reason: string | null } {
  if (DOWNLOAD_EXTENSIONS.has(extension)) {
    return { status: "downloading", isOrganizable: false, reason: "下载尚未完成" };
  }
  if (PROTECTED_NAMES.has(name.toLowerCase()) || !readable) {
    return { status: "protected", isOrganizable: false, reason: readable ? "系统文件保持原位" : "当前没有读取权限" };
  }
  return { status: "ready", isOrganizable: true, reason: null };
}

async function inspectEntry(
  directory: string,
  name: string,
  firstDiscovered: Map<string, string>,
  discoveredAt: string,
): Promise<FileRecord> {
  const absolutePath = path.join(directory, name);
  const extension = path.extname(name).toLowerCase();
  const id = stableFileId(directory, name);
  const firstDiscoveredAt = firstDiscovered.get(id) ?? discoveredAt;
  firstDiscovered.set(id, firstDiscoveredAt);

  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw Object.assign(new Error("Not a regular file"), { code: "SORTTIE_SKIP_SPECIAL" });
    }
    let readable = true;
    try {
      await access(absolutePath, fsConstants.R_OK);
    } catch {
      readable = false;
    }
    const category = classifyExtension(extension);
    const kind = kindByCategory[category];
    const availability = statusFor(name, extension, readable);
    return {
      id,
      name,
      extension,
      absolutePath,
      parentDirectory: directory,
      sizeBytes: metadata.size,
      createdAt: Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0 ? asIso(metadata.birthtimeMs) : null,
      modifiedAt: asIso(metadata.mtimeMs),
      firstDiscoveredAt,
      discoveredAt: Date.parse(firstDiscoveredAt),
      lastActivityAt: metadata.mtimeMs,
      lastActivityKind: "observed",
      category,
      kind,
      previewCapability: previewCapabilityFor(extension, kind),
      status: availability.status,
      isOrganizable: availability.isOrganizable,
      unavailableReason: availability.reason,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "SORTTIE_SKIP_SPECIAL") throw error;
    console.warn(`[Sorttie] 无法读取文件元数据：${name} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    const category = classifyExtension(extension);
    const kind = kindByCategory[category];
    const timestamp = Date.parse(discoveredAt);
    return {
      id,
      name,
      extension,
      absolutePath,
      parentDirectory: directory,
      sizeBytes: 0,
      createdAt: null,
      modifiedAt: discoveredAt,
      firstDiscoveredAt,
      discoveredAt: timestamp,
      lastActivityAt: timestamp,
      lastActivityKind: "observed",
      category,
      kind,
      previewCapability: previewCapabilityFor(extension, kind),
      status: "protected",
      isOrganizable: false,
      unavailableReason: "暂时无法读取文件信息",
    };
  }
}

function recordChanged(previous: FileRecord, next: FileRecord): boolean {
  return previous.sizeBytes !== next.sizeBytes
    || previous.modifiedAt !== next.modifiedAt
    || previous.status !== next.status
    || previous.isOrganizable !== next.isOrganizable;
}

function applyActivity(
  previousFiles: readonly FileRecord[],
  nextFiles: readonly FileRecord[],
  reason: SnapshotReason,
): readonly FileRecord[] {
  if (reason !== "watch") return nextFiles;
  const previousById = new Map(previousFiles.map((file) => [file.id, file]));
  const occurredAt = Date.now();
  return nextFiles.map((file) => {
    const previous = previousById.get(file.id);
    if (!previous) return { ...file, lastActivityAt: occurredAt, lastActivityKind: "created" as FileActivityKind };
    if (recordChanged(previous, file)) return { ...file, lastActivityAt: occurredAt, lastActivityKind: "modified" as FileActivityKind };
    return { ...file, lastActivityAt: previous.lastActivityAt, lastActivityKind: previous.lastActivityKind };
  }).sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

export async function scanTopLevelFiles(
  directory: string,
  firstDiscovered = new Map<string, string>(),
): Promise<readonly FileRecord[]> {
  const resolvedDirectory = path.resolve(directory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const regularFiles = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink());
  const discoveredAt = new Date().toISOString();
  const files: FileRecord[] = [];
  const concurrency = 32;

  for (let offset = 0; offset < regularFiles.length; offset += concurrency) {
    const chunk = regularFiles.slice(offset, offset + concurrency);
    const results = await Promise.all(chunk.map(async (entry) => {
      try {
        return await inspectEntry(resolvedDirectory, entry.name, firstDiscovered, discoveredAt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "SORTTIE_SKIP_SPECIAL") {
          console.warn(`[Sorttie] 跳过无法确认安全性的目录项：${entry.name}`);
        }
        return null;
      }
    }));
    files.push(...results.filter((entry): entry is FileRecord => entry !== null));
  }

  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function inaccessibleMessage(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return "监控位置不存在或已被移动。";
  if (error.code === "EACCES" || error.code === "EPERM") return "Sorttie 当前没有权限读取这个位置。";
  return "扫描监控位置时发生错误，请重试。";
}

function isInaccessible(error: NodeJS.ErrnoException): boolean {
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "");
}

function snapshotNotice(previous: readonly FileRecord[], next: readonly FileRecord[]): string | null {
  const before = new Map(previous.map((file) => [file.id, file]));
  const after = new Map(next.map((file) => [file.id, file]));
  const added = next.filter((file) => !before.has(file.id)).length;
  const removed = previous.filter((file) => !after.has(file.id)).length;
  const changed = next.filter((file) => {
    const old = before.get(file.id);
    return old && (old.sizeBytes !== file.sizeBytes || old.modifiedAt !== file.modifiedAt || old.isOrganizable !== file.isOrganizable);
  }).length;
  const parts = [added ? `新增 ${added} 项` : "", changed ? `更新 ${changed} 项` : "", removed ? `移除 ${removed} 项` : ""].filter(Boolean);
  return parts.length ? parts.join("，") : null;
}

type Listener = (event: FileChangeEvent) => void;

export class WatchDirectoryManager {
  private readonly configPath: string;
  private readonly listeners = new Set<Listener>();
  private readonly firstDiscovered = new Map<string, string>();
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private directory: string | null = null;
  private files: readonly FileRecord[] = [];
  private generation = 0;
  private state: WatchDirectoryState = {
    phase: "unconfigured",
    directory: null,
    message: "尚未选择监控文件夹。",
    isWatching: false,
    lastUpdatedAt: null,
  };

  constructor(userDataDirectory: string, debounceMs = 160) {
    this.configPath = path.join(userDataDirectory, "watch-directory.json");
    this.debounceMs = debounceMs;
  }

  getState(): WatchDirectoryState {
    return this.state;
  }

  getFiles(): readonly FileRecord[] {
    return this.files;
  }

  getSnapshot(reason: SnapshotReason): FileSnapshot {
    return { state: this.state, files: this.files, reason };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<FileSnapshot> {
    try {
      const raw = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || !("directory" in raw) || typeof raw.directory !== "string" || !path.isAbsolute(raw.directory)) {
        throw new Error("Invalid saved directory");
      }
      return await this.setDirectory(raw.directory, false, "startup");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.warn(`[Sorttie] 无法读取监控位置配置 (${code ?? "invalid"})`);
      return this.getSnapshot("startup");
    }
  }

  async setDirectory(directory: string, persist = true, reason: SnapshotReason = "directory-change"): Promise<FileSnapshot> {
    if (!path.isAbsolute(directory)) throw new TypeError("Watch directory must be absolute");
    await this.closeWatcher();
    this.generation += 1;
    const generation = this.generation;
    this.directory = path.resolve(directory);
    this.files = [];
    this.firstDiscovered.clear();
    this.state = {
      phase: "scanning",
      directory: this.directory,
      message: "正在读取当前目录的第一层文件…",
      isWatching: false,
      lastUpdatedAt: null,
    };
    this.emit(reason, null);

    try {
      if (persist) {
        await mkdir(path.dirname(this.configPath), { recursive: true });
        await writeFile(this.configPath, JSON.stringify({ directory: this.directory }, null, 2), "utf8");
      }
      this.watcher = this.createWatcher(this.directory, generation);
      return await this.refresh(reason, generation);
    } catch (error) {
      await this.closeWatcher();
      if (generation !== this.generation) return this.getSnapshot(reason);
      const typedError = error as NodeJS.ErrnoException;
      this.state = {
        phase: isInaccessible(typedError) ? "inaccessible" : "error",
        directory: this.directory,
        message: inaccessibleMessage(typedError),
        isWatching: false,
        lastUpdatedAt: new Date().toISOString(),
      };
      this.files = [];
      this.emit(reason, null);
      return this.getSnapshot(reason);
    }
  }

  async rescan(): Promise<FileSnapshot> {
    if (!this.directory) return this.getSnapshot("manual");
    const generation = this.generation;
    this.state = { ...this.state, phase: "scanning", message: "正在重新扫描…" };
    this.emit("manual", null);
    return this.refresh("manual", generation);
  }

  async getRegisteredImagePath(fileId: string): Promise<string | null> {
    const registered = await this.resolveRegisteredFile(fileId);
    if (!registered || registered.file.previewCapability !== "image" || registered.metadata.size > 64 * 1024 * 1024) return null;
    return registered.absolutePath;
  }

  async getRegisteredActionPath(fileId: string): Promise<string | null> {
    return (await this.resolveRegisteredFile(fileId))?.absolutePath ?? null;
  }

  async getRegisteredPreview(fileId: string): Promise<{ absolutePath: string; mimeType: string } | null> {
    const registered = await this.resolveRegisteredFile(fileId);
    if (!registered || !["video", "audio", "pdf"].includes(registered.file.previewCapability)) return null;
    const mimeType = MEDIA_MIME_TYPES[registered.file.extension];
    return mimeType ? { absolutePath: registered.absolutePath, mimeType } : null;
  }

  async readRegisteredTextPreview(fileId: string, maxBytes = 64 * 1024): Promise<TextPreview | null> {
    const registered = await this.resolveRegisteredFile(fileId);
    if (!registered || registered.file.previewCapability !== "text" || maxBytes < 1 || maxBytes > 64 * 1024) return null;
    const handle = await open(registered.absolutePath, "r");
    try {
      const fileSize = Number(registered.metadata.size);
      const buffer = Buffer.alloc(Math.min(maxBytes, fileSize));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        text: new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, bytesRead)),
        truncated: fileSize > bytesRead,
      };
    } finally {
      await handle.close();
    }
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.listeners.clear();
    await this.closeWatcher();
  }

  private createWatcher(directory: string, generation: number): FSWatcher {
    const watcher = chokidar.watch(directory, {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 140, pollInterval: 40 },
    });
    watcher.on("all", (eventName) => {
      if (["add", "change", "unlink", "addDir", "unlinkDir"].includes(eventName)) this.scheduleRefresh(generation);
    });
    watcher.on("error", (error) => void this.handleWatcherError(error, generation));
    return watcher;
  }

  private scheduleRefresh(generation: number): void {
    if (generation !== this.generation) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh("watch", generation);
    }, this.debounceMs);
  }

  private async refresh(reason: SnapshotReason, generation: number): Promise<FileSnapshot> {
    if (!this.directory) return this.getSnapshot(reason);
    const previous = this.files;
    try {
      const scannedFiles = await scanTopLevelFiles(this.directory, this.firstDiscovered);
      if (generation !== this.generation) return this.getSnapshot(reason);
      const files = applyActivity(previous, scannedFiles, reason);
      this.files = files;
      this.state = {
        phase: files.length ? "watching" : "empty",
        directory: this.directory,
        message: files.length ? `正在监控 ${files.length} 个第一层文件。` : "当前目录没有第一层普通文件。",
        isWatching: this.watcher !== null,
        lastUpdatedAt: new Date().toISOString(),
      };
      this.emit(reason, reason === "watch" ? snapshotNotice(previous, files) : null);
    } catch (error) {
      if (generation !== this.generation) return this.getSnapshot(reason);
      await this.closeWatcher();
      const typedError = error as NodeJS.ErrnoException;
      this.files = [];
      this.state = {
        phase: isInaccessible(typedError) ? "inaccessible" : "error",
        directory: this.directory,
        message: inaccessibleMessage(typedError),
        isWatching: false,
        lastUpdatedAt: new Date().toISOString(),
      };
      this.emit(reason, null);
    }
    return this.getSnapshot(reason);
  }

  private async handleWatcherError(error: unknown, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    console.warn(`[Sorttie] 文件监听失败 (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    await this.closeWatcher();
    this.state = {
      ...this.state,
      phase: "error",
      message: "文件监听已中断，请手动重试。",
      isWatching: false,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.emit("watch", "文件监听已中断");
  }

  private emit(reason: SnapshotReason, notice: string | null): void {
    const event: FileChangeEvent = { type: "snapshot", snapshot: this.getSnapshot(reason), notice };
    this.listeners.forEach((listener) => listener(event));
  }

  private async resolveRegisteredFile(fileId: string): Promise<{ file: FileRecord; absolutePath: string; metadata: Awaited<ReturnType<typeof lstat>> } | null> {
    const file = this.files.find((entry) => entry.id === fileId);
    if (!file || !this.directory) return null;
    const absolutePath = path.resolve(file.absolutePath);
    if (normalizeForId(path.dirname(absolutePath)) !== normalizeForId(this.directory)) return null;
    try {
      const metadata = await lstat(absolutePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return { file, absolutePath, metadata };
    } catch {
      return null;
    }
  }

  private async closeWatcher(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
  }
}
