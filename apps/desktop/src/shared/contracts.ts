export const CATEGORIES = ["图片", "视频", "音频", "文档", "代码与数据", "压缩包", "其他"] as const;
export type Category = (typeof CATEGORIES)[number];

export const FILE_KINDS = ["image", "video", "audio", "document", "code", "archive", "unknown"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_STATUSES = ["ready", "modified", "downloading", "protected", "conflict"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const PREVIEW_CAPABILITIES = ["image", "video", "audio", "pdf", "text", "unsupported"] as const;
export type PreviewCapability = (typeof PREVIEW_CAPABILITIES)[number];

export const FILE_ACTIVITY_KINDS = ["observed", "created", "modified"] as const;
export type FileActivityKind = (typeof FILE_ACTIVITY_KINDS)[number];

export const APP_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export const WATCH_PHASES = ["unconfigured", "scanning", "watching", "empty", "inaccessible", "error"] as const;
export type WatchPhase = (typeof WATCH_PHASES)[number];

export type RecentFileRecord = Readonly<{
  id: string;
  name: string;
  extension: string;
  absolutePath: string;
  parentDirectory: string;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string;
  firstDiscoveredAt: string;
  discoveredAt: number;
  lastActivityAt: number;
  lastActivityKind: FileActivityKind;
  category: Category;
  kind: FileKind;
  previewCapability: PreviewCapability;
  status: FileStatus;
  isOrganizable: boolean;
  unavailableReason: string | null;
}>;

export type FileRecord = RecentFileRecord;

export type WatchDirectoryState = Readonly<{
  phase: WatchPhase;
  directory: string | null;
  message: string;
  isWatching: boolean;
  lastUpdatedAt: string | null;
}>;

export type SnapshotReason = "startup" | "directory-change" | "manual" | "watch";

export type FileSnapshot = Readonly<{
  state: WatchDirectoryState;
  files: readonly FileRecord[];
  reason: SnapshotReason;
}>;

export type ChooseWatchDirectoryResult = Readonly<{
  cancelled: boolean;
  snapshot: FileSnapshot;
}>;

export type FileChangeEvent = Readonly<{
  type: "snapshot";
  snapshot: FileSnapshot;
  notice: string | null;
}>;

export type AppInfo = Readonly<{
  name: string;
  version: string;
  readOnly: boolean;
  platform: AppPlatform;
}>;

export const FILE_ACTIONS = ["open", "open-with", "show-in-folder", "copy-file-path", "copy-folder-path"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export type FileActionResult = Readonly<{
  ok: boolean;
  message: string;
  code: string | null;
}>;

export type TextPreview = Readonly<{
  text: string;
  truncated: boolean;
}>;

export type LocalAiClassificationResult = Readonly<{
  status: "ready";
  fileId: string;
  model: string;
  category: Category;
  confidence: number;
  tags: readonly string[];
  reason: string;
  usedTextContent: boolean;
}> | Readonly<{
  status: "unavailable" | "failed";
  fileId: string;
  model: string | null;
  code: string;
  message: string;
}>;

export type FavoriteSnapshot = Readonly<{ directory: string | null; fileIds: readonly string[] }>;
export type FavoriteResult = FileActionResult & Readonly<{ fileId: string; favorite: boolean }>;

export function parseFavoriteFlag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Invalid favorite flag");
  return value;
}
export function parseFavoriteSnapshot(value: unknown): FavoriteSnapshot {
  if (!isObject(value) || !isStringOrNull(value.directory) || !Array.isArray(value.fileIds)) throw new TypeError("Invalid favorite snapshot");
  const fileIds = value.fileIds.map(parseFileId);
  if (new Set(fileIds).size !== fileIds.length || (value.directory === null && fileIds.length)) throw new TypeError("Invalid favorite identifiers");
  return { directory: value.directory, fileIds };
}
export function parseFavoriteResult(value: unknown): FavoriteResult {
  const result = parseFileActionResult(value);
  if (!isObject(value)) throw new TypeError("Invalid favorite result");
  return { ...result, fileId: parseFileId(value.fileId), favorite: parseFavoriteFlag(value.favorite) };
}

export type OrganizationPlanRequestItem = Readonly<{
  fileId: string;
  category: Category;
  protectionConfirmation?: string;
}>;

export type JianyingReference = Readonly<{
  project: string; timeline: string; kind: "current" | "backup";
  source: string; observedAt: string; revision: string; filePath: string;
}>;
export type JianyingFileProtection = Readonly<{
  fileId: string; level: "none" | "current" | "backup";
  references: readonly JianyingReference[]; confirmation: string | null;
}>;
export type JianyingSnapshot = Readonly<{
  root: string | null; incomplete: number; files: readonly JianyingFileProtection[];
}>;
export function parseJianyingSnapshot(value: unknown): JianyingSnapshot {
  if (!isObject(value) || !isStringOrNull(value.root) || !Number.isSafeInteger(value.incomplete)
    || (value.incomplete as number) < 0 || !Array.isArray(value.files)) throw new TypeError("Invalid protection snapshot");
  const files = value.files.map((file) => {
    if (!isObject(file) || !["none", "current", "backup"].includes(file.level as string)
      || !isStringOrNull(file.confirmation) || !Array.isArray(file.references)) throw new TypeError("Invalid file protection");
    const references = file.references.map((reference) => {
      if (!isObject(reference) || !["current", "backup"].includes(reference.kind as string)
        || !["project", "timeline", "source", "observedAt", "revision", "filePath"].every((key) => typeof reference[key] === "string")) throw new TypeError("Invalid reference");
      return { project: reference.project, timeline: reference.timeline, kind: reference.kind, source: reference.source,
        observedAt: reference.observedAt, revision: reference.revision, filePath: reference.filePath } as JianyingReference;
    });
    return { fileId: parseFileId(file.fileId), level: file.level, references, confirmation: file.confirmation } as JianyingFileProtection;
  });
  return { root: value.root as string | null, incomplete: value.incomplete as number, files };
}

export type OrganizationDestinationMode = "categorized" | "choose-root" | "same-location";

export function parseOrganizationDestinationMode(value: unknown): OrganizationDestinationMode {
  if (value !== "categorized" && value !== "choose-root" && value !== "same-location") {
    throw new TypeError("Invalid organization destination mode");
  }
  return value;
}

export function parseOrganizationRoot(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value))) {
    throw new TypeError("Invalid organization root");
  }
  return value as string | null;
}

export type OrganizationPreparedItem = Readonly<{
  fileId: string;
  operationId: string;
  destinationPath: string;
}>;

export type OrganizationPreparationResult = Readonly<{
  status: "prepared" | "cancelled" | "blocked";
  planId: string | null;
  destinationDirectory: string | null;
  items: readonly OrganizationPreparedItem[];
  code: string | null;
  message: string;
}>;

export type OrganizationActionResult = Readonly<{
  status: "moved" | "undone" | "blocked" | "failed";
  operationId: string;
  code: string | null;
  message: string;
}>;

export type SorttieApi = Readonly<{
  getJianyingProtection(): Promise<JianyingSnapshot>;
  chooseJianyingDirectory(): Promise<JianyingSnapshot>;
  getAppInfo(): Promise<AppInfo>;
  chooseWatchDirectory(): Promise<ChooseWatchDirectoryResult>;
  getWatchDirectoryState(): Promise<WatchDirectoryState>;
  getCurrentFiles(): Promise<readonly FileRecord[]>;
  getFavoriteFileIds(): Promise<FavoriteSnapshot>;
  setFileFavorite(fileId: string, favorite: boolean): Promise<FavoriteResult>;
  rescanWatchDirectory(): Promise<FileSnapshot>;
  getImageThumbnail(fileId: string): Promise<string | null>;
  openFile(fileId: string): Promise<FileActionResult>;
  openWith(fileId: string): Promise<FileActionResult>;
  showItemInFolder(fileId: string): Promise<FileActionResult>;
  copyFilePath(fileId: string): Promise<FileActionResult>;
  copyFolderPath(fileId: string): Promise<FileActionResult>;
  startFileDrag(fileId: string): void;
  readTextPreview(fileId: string): Promise<TextPreview | null>;
  classifyFileWithLocalAi(fileId: string): Promise<LocalAiClassificationResult>;
  getOrganizationRoot(): Promise<string | null>;
  prepareOrganizationPlan(items: readonly OrganizationPlanRequestItem[], mode?: OrganizationDestinationMode): Promise<OrganizationPreparationResult>;
  executeOrganization(operationId: string): Promise<OrganizationActionResult>;
  undoOrganization(operationId: string): Promise<OrganizationActionResult>;
  subscribeToFileChanges(listener: (event: FileChangeEvent) => void): () => void;
}>;

export const IPC_CHANNELS = Object.freeze({
  jianyingProtection: "sorttie:jianying-protection",
  chooseJianyingDirectory: "sorttie:choose-jianying-directory",
  appInfo: "sorttie:get-app-info",
  chooseWatchDirectory: "sorttie:choose-watch-directory",
  watchDirectoryState: "sorttie:get-watch-directory-state",
  currentFiles: "sorttie:get-current-files",
  favoriteFileIds: "sorttie:get-favorite-file-ids",
  setFileFavorite: "sorttie:set-file-favorite",
  rescan: "sorttie:rescan-watch-directory",
  imageThumbnail: "sorttie:get-image-thumbnail",
  openFile: "sorttie:open-file",
  openWith: "sorttie:open-with",
  showItemInFolder: "sorttie:show-item-in-folder",
  copyFilePath: "sorttie:copy-file-path",
  copyFolderPath: "sorttie:copy-folder-path",
  startFileDrag: "sorttie:start-file-drag",
  textPreview: "sorttie:read-text-preview",
  localAiClassification: "sorttie:classify-file-with-local-ai",
  prepareOrganizationPlan: "sorttie:prepare-organization-plan",
  organizationRoot: "sorttie:get-organization-root",
  executeOrganization: "sorttie:execute-organization",
  undoOrganization: "sorttie:undo-organization",
  fileChanges: "sorttie:file-changes",
});

export const REGISTERED_FILE_SCHEME = "sorttie-file";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isStringOrNull = (value: unknown): value is string | null => typeof value === "string" || value === null;
const isOneOf = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
  typeof value === "string" && values.includes(value);

export function parseFileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Invalid file identifier");
  }
  return value;
}

export function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^op_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError("Invalid operation identifier");
  }
  return value;
}

export function parsePlanId(value: unknown): string {
  if (typeof value !== "string" || !/^plan_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError("Invalid plan identifier");
  }
  return value;
}

export function parseCategory(value: unknown): Category {
  if (!isOneOf(value, CATEGORIES)) throw new TypeError("Invalid file category");
  return value;
}

export function parseOrganizationPlanRequest(value: unknown): readonly OrganizationPlanRequestItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("An organization plan requires at least one file");
  }
  const fileIds = new Set<string>();
  const items = value.map((entry) => {
    if (!isObject(entry)) throw new TypeError("Invalid organization plan item");
    const fileId = parseFileId(entry.fileId);
    if (fileIds.has(fileId)) throw new TypeError("Duplicate file in organization plan");
    fileIds.add(fileId);
    if (entry.protectionConfirmation !== undefined && (typeof entry.protectionConfirmation !== "string" || entry.protectionConfirmation.length > 262144)) throw new TypeError("Invalid protection confirmation");
    return Object.freeze({ fileId, category: parseCategory(entry.category), ...(entry.protectionConfirmation === undefined ? {} : { protectionConfirmation: entry.protectionConfirmation as string }) });
  });
  return Object.freeze(items);
}

export function parseFileRecord(value: unknown): FileRecord {
  if (!isObject(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.extension !== "string"
    || typeof value.absolutePath !== "string"
    || typeof value.parentDirectory !== "string"
    || typeof value.sizeBytes !== "number"
    || !Number.isFinite(value.sizeBytes)
    || !isStringOrNull(value.createdAt)
    || typeof value.modifiedAt !== "string"
    || typeof value.firstDiscoveredAt !== "string"
    || typeof value.discoveredAt !== "number"
    || !Number.isFinite(value.discoveredAt)
    || typeof value.lastActivityAt !== "number"
    || !Number.isFinite(value.lastActivityAt)
    || !isOneOf(value.lastActivityKind, FILE_ACTIVITY_KINDS)
    || !isOneOf(value.category, CATEGORIES)
    || !isOneOf(value.kind, FILE_KINDS)
    || !isOneOf(value.previewCapability, PREVIEW_CAPABILITIES)
    || !isOneOf(value.status, FILE_STATUSES)
    || typeof value.isOrganizable !== "boolean"
    || !isStringOrNull(value.unavailableReason)) {
    throw new TypeError("Invalid file record received over IPC");
  }
  parseFileId(value.id);
  return value as FileRecord;
}

export function parseFileRecords(value: unknown): readonly FileRecord[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid file list received over IPC");
  return value.map(parseFileRecord);
}

export function parseWatchDirectoryState(value: unknown): WatchDirectoryState {
  if (!isObject(value)
    || !isOneOf(value.phase, WATCH_PHASES)
    || !isStringOrNull(value.directory)
    || typeof value.message !== "string"
    || typeof value.isWatching !== "boolean"
    || !isStringOrNull(value.lastUpdatedAt)) {
    throw new TypeError("Invalid watch-directory state received over IPC");
  }
  return value as WatchDirectoryState;
}

export function parseFileSnapshot(value: unknown): FileSnapshot {
  if (!isObject(value) || !isOneOf(value.reason, ["startup", "directory-change", "manual", "watch"] as const)) {
    throw new TypeError("Invalid file snapshot received over IPC");
  }
  return {
    state: parseWatchDirectoryState(value.state),
    files: parseFileRecords(value.files),
    reason: value.reason,
  };
}

export function parseChooseResult(value: unknown): ChooseWatchDirectoryResult {
  if (!isObject(value) || typeof value.cancelled !== "boolean") {
    throw new TypeError("Invalid directory-choice result received over IPC");
  }
  return { cancelled: value.cancelled, snapshot: parseFileSnapshot(value.snapshot) };
}

export function parseFileChangeEvent(value: unknown): FileChangeEvent {
  if (!isObject(value) || value.type !== "snapshot" || !isStringOrNull(value.notice)) {
    throw new TypeError("Invalid file-change event received over IPC");
  }
  return { type: "snapshot", snapshot: parseFileSnapshot(value.snapshot), notice: value.notice };
}

export function parseAppInfo(value: unknown): AppInfo {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.version !== "string" || typeof value.readOnly !== "boolean" || !isOneOf(value.platform, APP_PLATFORMS)) {
    throw new TypeError("Invalid application information received over IPC");
  }
  return value as AppInfo;
}

export function parseThumbnail(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || !value.startsWith("data:image/"))) {
    throw new TypeError("Invalid thumbnail received over IPC");
  }
  return value as string | null;
}

export function parseFileActionResult(value: unknown): FileActionResult {
  if (!isObject(value) || typeof value.ok !== "boolean" || typeof value.message !== "string" || !isStringOrNull(value.code)) {
    throw new TypeError("Invalid file-action result received over IPC");
  }
  return value as FileActionResult;
}

export function parseTextPreview(value: unknown): TextPreview | null {
  if (value === null) return null;
  if (!isObject(value) || typeof value.text !== "string" || typeof value.truncated !== "boolean") {
    throw new TypeError("Invalid text preview received over IPC");
  }
  return value as TextPreview;
}

export function parseLocalAiClassificationResult(value: unknown): LocalAiClassificationResult {
  if (!isObject(value)
    || !isOneOf(value.status, ["ready", "unavailable", "failed"] as const)
    || typeof value.fileId !== "string") {
    throw new TypeError("Invalid local AI classification result");
  }
  parseFileId(value.fileId);
  if (value.status === "ready") {
    if (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 128
      || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
      || !Array.isArray(value.tags) || value.tags.length > 3
      || value.tags.some((tag) => typeof tag !== "string" || tag.length < 1 || tag.length > 32)
      || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 240
      || typeof value.usedTextContent !== "boolean") {
      throw new TypeError("Invalid local AI classification suggestion");
    }
    parseCategory(value.category);
  } else if ((value.model !== null && (typeof value.model !== "string" || value.model.length > 128))
    || typeof value.code !== "string" || value.code.length < 1 || value.code.length > 64
    || typeof value.message !== "string" || value.message.length < 1 || value.message.length > 240) {
    throw new TypeError("Invalid local AI classification failure");
  }
  return value as LocalAiClassificationResult;
}

export function parseOrganizationPreparationResult(value: unknown): OrganizationPreparationResult {
  if (!isObject(value)
    || !isOneOf(value.status, ["prepared", "cancelled", "blocked"] as const)
    || !isStringOrNull(value.planId)
    || !isStringOrNull(value.destinationDirectory)
    || !Array.isArray(value.items)
    || !isStringOrNull(value.code)
    || typeof value.message !== "string") {
    throw new TypeError("Invalid organization preparation result");
  }
  if (value.status === "prepared") {
    parsePlanId(value.planId);
    if (!value.destinationDirectory || value.items.length === 0) {
      throw new TypeError("Prepared organization result is missing its destination");
    }
    const fileIds = new Set<string>();
    for (const item of value.items) {
      if (!isObject(item)
        || typeof item.destinationPath !== "string"
        || item.destinationPath.length === 0) {
        throw new TypeError("Prepared organization result contains an invalid item");
      }
      const fileId = parseFileId(item.fileId);
      if (fileIds.has(fileId)) throw new TypeError("Prepared organization result contains a duplicate file");
      fileIds.add(fileId);
      parseOperationId(item.operationId);
    }
  } else if (value.planId !== null || value.destinationDirectory !== null || value.items.length !== 0) {
    throw new TypeError("Inactive organization result contains an operation");
  }
  return value as OrganizationPreparationResult;
}

export function parseOrganizationActionResult(value: unknown): OrganizationActionResult {
  if (!isObject(value)
    || !isOneOf(value.status, ["moved", "undone", "blocked", "failed"] as const)
    || typeof value.operationId !== "string"
    || !isStringOrNull(value.code)
    || typeof value.message !== "string") {
    throw new TypeError("Invalid organization action result");
  }
  parseOperationId(value.operationId);
  return value as OrganizationActionResult;
}

export function registeredFileUrl(fileId: string): string {
  return `${REGISTERED_FILE_SCHEME}://preview/${parseFileId(fileId)}`;
}
