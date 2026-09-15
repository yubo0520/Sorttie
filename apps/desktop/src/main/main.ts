import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { openSorttieDatabase } from "./database";
import { WatchDirectoryManager } from "./fileMonitor";
import { LocalFileOperationService } from "./localFileOperationService";
import { LocalAiClassifier } from "./localAiClassifier";
import { scanJianying, fileProtection, findSafeJianyingRoot, protectionConclusion } from "./jianyingProtection";
import type { FileIdentitySnapshot, OperationId } from "./organizationPlan";
import { OrganizationPlanStore } from "./organizationPlanStore";
import {
  FILE_ACTIONS,
  IPC_CHANNELS,
  REGISTERED_FILE_SCHEME,
  parseAppInfo,
  parseJianyingSnapshot,
  parseLocalAiClassificationResult,
  parseChooseResult,
  parseFileActionResult,
  parseFileChangeEvent,
  parseFileId,
  parseFavoriteFlag,
  parseFavoriteSnapshot,
  parseFavoriteResult,
  parseFileRecords,
  parseFileSnapshot,
  parseOperationId,
  parseOrganizationPlanRequest,
  parseOrganizationDestinationMode,
  parseOrganizationRoot,
  parseOrganizationActionResult,
  parseOrganizationPreparationResult,
  parseTextPreview,
  parseThumbnail,
  parseWatchDirectoryState,
  type FileAction,
  type FileActionResult,
  type OrganizationPlanRequestItem,
  type OrganizationDestinationMode,
  type OrganizationPreparationResult,
} from "../shared/contracts";

protocol.registerSchemesAsPrivileged([{
  scheme: REGISTERED_FILE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const requestedScale = process.env.SORTTIE_DEMO_SCALE;
if (requestedScale && /^\d+(\.\d+)?$/.test(requestedScale)) {
  app.commandLine.appendSwitch("force-device-scale-factor", requestedScale);
}

let mainWindow: BrowserWindow | null = null;
let watchManager: WatchDirectoryManager | null = null;
let watchManagerReady: Promise<unknown> = Promise.resolve();
let operationsDatabase: DatabaseSync | null = null;
let planStore: OrganizationPlanStore | null = null;
let localFileOperations: LocalFileOperationService | null = null;
const windowStateFile = "window-state.json";
const defaultWindowSize = { width: 1120, height: 600 };
const fileActionTestMode = process.env.SORTTIE_TEST_FILE_ACTIONS;
const useMockFileActions = fileActionTestMode === "mock" || fileActionTestMode === "clipboard";
const localAiClassifier = new LocalAiClassifier();

const testUserData = process.env.SORTTIE_TEST_USER_DATA;
if (testUserData && path.isAbsolute(testUserData)) {
  app.setPath("userData", testUserData);
}

function isTrustedRenderer(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.pathname.endsWith("/dist-renderer/index.html");
  } catch {
    return false;
  }
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function initialWindowSize(): Promise<{ width: number; height: number }> {
  if (process.env.SORTTIE_DEMO_WIDTH || process.env.SORTTIE_DEMO_HEIGHT) {
    return {
      width: numericEnv("SORTTIE_DEMO_WIDTH", defaultWindowSize.width),
      height: numericEnv("SORTTIE_DEMO_HEIGHT", defaultWindowSize.height),
    };
  }
  try {
    const parsed = JSON.parse(await readFile(path.join(app.getPath("userData"), windowStateFile), "utf8")) as { width?: unknown; height?: unknown };
    if (typeof parsed.width === "number" && typeof parsed.height === "number" && parsed.width >= 960 && parsed.height >= 540 && parsed.width <= 7680 && parsed.height <= 4320) {
      return { width: Math.round(parsed.width), height: Math.round(parsed.height) };
    }
  } catch {
    // Missing or invalid window state falls back to the confirmed compact size.
  }
  return defaultWindowSize;
}

function assertTrustedRequest(event: Electron.IpcMainInvokeEvent, args: readonly unknown[], expectedArguments: number): void {
  if (!isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("Untrusted renderer");
  if (args.length !== expectedArguments) throw new TypeError("Invalid IPC argument count");
}

type TrustedIpcEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent;

function assertTrustedEvent(event: TrustedIpcEvent, args: readonly unknown[], expectedArguments: number): void {
  if (!isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("Untrusted renderer");
  if (args.length !== expectedArguments) throw new TypeError("Invalid IPC argument count");
}

async function manager(): Promise<WatchDirectoryManager> {
  await watchManagerReady;
  if (!watchManager) throw new Error("Watch manager is not available");
  return watchManager;
}

function operationService(): LocalFileOperationService {
  if (!localFileOperations) throw new Error("File operation service is not available");
  return localFileOperations;
}

function plans(): OrganizationPlanStore {
  if (!planStore) throw new Error("Organization plan store is not available");
  return planStore;
}

async function openWithChooser(filePath: string): Promise<void> {
  if (process.platform !== "win32") throw Object.assign(new Error("Open With is only available on Windows"), { code: "UNSUPPORTED_PLATFORM" });
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["shell32.dll,OpenAs_RunDLL", filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const fileActionAdapter = useMockFileActions
  ? {
      open: async (_filePath: string) => undefined,
      openWith: async (_filePath: string) => undefined,
      showInFolder: (_filePath: string) => undefined,
      copyPath: (filePath: string) => {
        if (fileActionTestMode === "clipboard") clipboard.writeText(filePath);
      },
    }
  : {
      open: async (filePath: string) => {
        const errorMessage = await shell.openPath(filePath);
        if (errorMessage) throw new Error(errorMessage);
      },
      openWith: openWithChooser,
      showInFolder: (filePath: string) => shell.showItemInFolder(filePath),
      copyPath: (filePath: string) => clipboard.writeText(filePath),
    };

const actionSuccessMessages: Record<FileAction, string> = {
  open: "已交给系统打开",
  "open-with": "已打开“打开方式”",
  "show-in-folder": "已在资源管理器中显示",
  "copy-file-path": "已复制文件路径",
  "copy-folder-path": "已复制文件夹路径",
};

async function performFileAction(action: FileAction, fileId: string): Promise<FileActionResult> {
  const filePath = await (await manager()).getRegisteredActionPath(fileId);
  if (!filePath) return parseFileActionResult({ ok: false, message: "文件已不在监控目录中", code: "FILE_NOT_AVAILABLE" });
  try {
    if (action === "open") await fileActionAdapter.open(filePath);
    if (action === "open-with") await fileActionAdapter.openWith(filePath);
    if (action === "show-in-folder") fileActionAdapter.showInFolder(filePath);
    if (action === "copy-file-path") fileActionAdapter.copyPath(filePath);
    if (action === "copy-folder-path") fileActionAdapter.copyPath(path.dirname(filePath));
    return parseFileActionResult({ ok: true, message: actionSuccessMessages[action], code: null });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "FILE_ACTION_FAILED";
    console.warn(`[Sorttie] 文件操作失败：${action} (${code})`);
    const message = code === "UNSUPPORTED_PLATFORM" ? "当前系统不支持这个操作" : "无法完成文件操作，请确认文件仍然可用";
    return parseFileActionResult({ ok: false, message, code });
  }
}

async function getOrganizationRoot(): Promise<string | null> {
  try {
    const config = JSON.parse(await readFile(path.join(app.getPath("userData"), "organization-root.json"), "utf8"));
    return parseOrganizationRoot(config.directory);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw new Error("无法读取整理根目录设置，请重新选择。");
  }
}

async function chooseOrganizationDestination(sameLocation: boolean): Promise<string | null> {
  const testDestination = process.env.SORTTIE_TEST_ORGANIZE_DESTINATION;
  if (testDestination) {
    if (!path.isAbsolute(testDestination)) throw new TypeError("Test organization destination must be absolute");
    return path.resolve(testDestination);
  }
  const options: Electron.OpenDialogOptions = {
    title: sameLocation ? "全部放到同一位置" : "选择整理根目录",
    buttonLabel: sameLocation ? "确认统一位置" : "使用此根目录",
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length !== 1
    ? null
    : path.resolve(result.filePaths[0]);
}

async function jianyingRoot(): Promise<string | null> {
  const configPath = path.join(app.getPath("userData"), "jianying-root.json");
  try {
    const value = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof value.directory !== "string" || !path.isAbsolute(value.directory)) throw new Error("invalid_root");
    const configured = await findSafeJianyingRoot([value.directory]);
    if (!configured) throw Object.assign(new Error("configured_root_unavailable"), { code: "JIANYING_ROOT_UNAVAILABLE" });
    return configured;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      const candidates = testUserData
        ? (process.env.SORTTIE_TEST_JIANYING_ROOT ? [process.env.SORTTIE_TEST_JIANYING_ROOT] : [])
        : conventionalJianyingRoots();
      const discovered = await findSafeJianyingRoot(candidates);
      if (discovered) await writeFile(configPath, JSON.stringify({ directory: discovered }), "utf8");
      return discovered;
    }
    throw new Error("无法读取剪映保护配置，请重新选择草稿目录");
  }
}

function conventionalJianyingRoots(): string[] {
  const profile = process.env.USERPROFILE;
  const watchedDirectory = watchManager?.getState().directory;
  const roots = profile ? [
    path.join(profile, "AppData", "Local", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
    path.join(profile, "Documents", "JianyingPro Drafts"),
  ] : [];
  const driveRoots = new Set([
    profile ? path.parse(profile).root : "",
    path.parse(app.getAppPath()).root,
    watchedDirectory ? path.parse(watchedDirectory).root : "",
  ].filter(Boolean));
  for (const driveRoot of driveRoots) {
    roots.push(path.join(driveRoot, "Jianying", "JianyingPro Drafts"), path.join(driveRoot, "JianyingPro Drafts"));
  }
  return roots;
}

async function currentJianyingScan() {
  const root = await jianyingRoot();
  const scan = await scanJianying(root);
  if (root && !scan.rootAccessible) {
    throw Object.assign(new Error("jianying_scan_unavailable"), { code: "JIANYING_SCAN_UNAVAILABLE" });
  }
  return scan;
}

async function jianyingSnapshot() {
  const current = await manager();
  const scan = await currentJianyingScan();
  return parseJianyingSnapshot({ root: scan.root, incomplete: scan.incomplete,
    files: current.getFiles().map((file) => fileProtection(scan, file.id, file.absolutePath)) });
}

async function prepareOrganizationPlan(
  requestItems: readonly OrganizationPlanRequestItem[],
  mode: OrganizationDestinationMode,
): Promise<OrganizationPreparationResult> {
  const currentManager = await manager();
  const watchedRoot = currentManager.getState().directory;
  if (!watchedRoot) {
    return {
      status: "blocked",
      planId: null,
      destinationDirectory: null,
      items: [],
      code: "FILE_NOT_AVAILABLE",
      message: "文件已不在监控目录中，请重新扫描后再试。",
    };
  }
  const sources = await Promise.all(requestItems.map(async (item) => ({
    ...item,
    sourcePath: await currentManager.getRegisteredActionPath(item.fileId),
  })));
  if (sources.some((item) => !item.sourcePath)) {
    return {
      status: "blocked",
      planId: null,
      destinationDirectory: null,
      items: [],
      code: "FILE_NOT_AVAILABLE",
      message: "部分文件已不在监控目录中，请重新扫描后再试。",
    };
  }

  let protectionScan: Awaited<ReturnType<typeof scanJianying>>;
  try {
    protectionScan = await currentJianyingScan();
  } catch {
    return { status: "blocked", planId: null, destinationDirectory: null, items: [], code: "PROJECT_PROTECTION_UNAVAILABLE", message: "剪映素材保护检查失败，已停止整理。请确认草稿目录仍然可访问。" };
  }
  const allowedSources = sources.filter((item) => {
    const protection = fileProtection(protectionScan, item.fileId, item.sourcePath!);
    return protection.level === "none" || (protection.level === "backup" && item.protectionConfirmation === protection.confirmation);
  });
  const eligibleSources = mode === "same-location" ? allowedSources : allowedSources.filter((item) => item.category !== "其他");
  if (eligibleSources.length === 0) {
    if (allowedSources.length === 0) return { status: "blocked", planId: null, destinationDirectory: null, items: [], code: "PROJECT_REFERENCES", message: "所选文件存在剪映引用，已保持原位。请检查引用信息。" };
    return { status: "blocked", planId: null, destinationDirectory: null, items: [], code: "DESTINATION_REQUIRED", message: "这些文件的去向需要确认；请选择分类，或使用“全部放到同一位置”。" };
  }
  const destinationDirectory = mode === "categorized"
    ? await getOrganizationRoot() ?? await chooseOrganizationDestination(false)
    : await chooseOrganizationDestination(mode === "same-location");
  if (!destinationDirectory) {
    return {
      status: "cancelled",
      planId: null,
      destinationDirectory: null,
      items: [],
      code: null,
      message: "已取消选择整理位置。",
    };
  }

  try {
    const [destinationDirectoryStats, watchedRootStats, sourceStats] = await Promise.all([
      lstat(destinationDirectory, { bigint: true }),
      lstat(watchedRoot, { bigint: true }),
      Promise.all(eligibleSources.map((item) => lstat(item.sourcePath!, { bigint: true }))),
    ]);
    if (!destinationDirectoryStats.isDirectory() || destinationDirectoryStats.isSymbolicLink()) {
      throw Object.assign(new Error("Destination is not a directory"), { code: "DESTINATION_NOT_DIRECTORY" });
    }
    if (path.resolve(await realpath(destinationDirectory)).toLowerCase() !== path.resolve(destinationDirectory).toLowerCase()) {
      throw Object.assign(new Error("Destination traverses a link"), { code: "DESTINATION_NOT_DIRECTORY" });
    }
    const directoryPolicies = await Promise.all(eligibleSources.map(async (item) => {
      if (mode === "same-location") return null;
      const directoryPath = path.join(destinationDirectory, item.category);
      let existed = false;
      try {
        const stats = await lstat(directoryPath, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw Object.assign(new Error("Invalid category directory"), { code: "DESTINATION_NOT_DIRECTORY" });
        existed = true;
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
      }
      return {
        rootPath: destinationDirectory,
        rootDev: destinationDirectoryStats.dev.toString(),
        rootIno: destinationDirectoryStats.ino.toString(),
        rootBirthtimeNs: destinationDirectoryStats.birthtimeNs.toString(),
        directoryPath,
        existed,
      };
    }));
    if (mode !== "same-location") {
      await writeFile(path.join(app.getPath("userData"), "organization-root.json"), JSON.stringify({ directory: destinationDirectory }), "utf8");
    }
    const plan = plans().createFrozenPlan({
      watchedRoot,
      watchedRootIdentity: watchedRootStats.dev === 0n ? null : watchedRootStats.dev.toString(),
      items: eligibleSources.map((item, index) => {
        const stats = sourceStats[index];
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw Object.assign(new Error("Source is not a regular file"), { code: "SOURCE_NOT_REGULAR" });
        }
        const sizeBytes = Number(stats.size);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
          throw Object.assign(new Error("Source size is not safe"), { code: "SOURCE_TOO_LARGE" });
        }
        const sourcePath = item.sourcePath!;
        const sourceIdentity: FileIdentitySnapshot = Object.freeze({
          volumeId: stats.dev === 0n ? null : stats.dev.toString(),
          fileId: null,
          sizeBytes,
          mtimeNs: stats.mtimeNs.toString(),
          birthtimeNs: stats.birthtimeNs.toString(),
          attributes: null,
          reparseTag: null,
          partialHash: null,
          dev: stats.dev === 0n ? null : stats.dev.toString(),
          ino: stats.ino === 0n ? null : stats.ino.toString(),
          identityAvailable: stats.dev !== 0n && stats.ino !== 0n,
        });
        const sameVolume = stats.dev !== 0n && destinationDirectoryStats.dev !== 0n
          ? stats.dev === destinationDirectoryStats.dev
          : path.parse(sourcePath).root.toLocaleLowerCase("en-US")
            === path.parse(destinationDirectory).root.toLocaleLowerCase("en-US");
        return {
          registeredFileId: item.fileId,
          sourcePath,
          destinationPath: path.join(directoryPolicies[index]?.directoryPath ?? destinationDirectory, path.basename(sourcePath)),
          category: item.category,
          conflictPolicy: "fail" as const,
          riskAccepted: fileProtection(protectionScan, item.fileId, sourcePath).level === "backup",
          protection: protectionConclusion(fileProtection(protectionScan, item.fileId, sourcePath)),
          expectedStrategy: sameVolume ? "same_volume_rename" as const : "copy_verify_delete" as const,
          sourceIdentity,
        };
      }),
    });
    const preparedItems = plan.items.map((item, index) => {
      const operationId = plans().ensurePreparedOperation(item.planItemId).operationId;
      if (directoryPolicies[index]) {
        operationsDatabase!.prepare(`INSERT INTO operation_events (operation_id, phase, recorded_at, details_json) VALUES (?, 'directory_planned', ?, ?)`).run(operationId, new Date().toISOString(), JSON.stringify(directoryPolicies[index]));
      }
      return { fileId: item.registeredFileId, operationId, destinationPath: item.destinationPath };
    });
    const heldCount = sources.length - eligibleSources.length;
    const incompleteSuffix = protectionScan.incomplete ? "，部分剪映草稿暂无法检查" : "";
    return {
      status: "prepared",
      planId: plan.planId,
      destinationDirectory,
      items: preparedItems,
      code: null,
      message: heldCount > 0
        ? `${preparedItems.length} 项将整理，${heldCount} 项保持原位${incompleteSuffix}。`
        : `${preparedItems.length} 项将整理${incompleteSuffix}。`,
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    console.warn(`[Sorttie] 无法冻结单文件整理计划 (${code})`);
    return {
      status: "blocked",
      planId: null,
      destinationDirectory: null,
      items: [],
      code,
      message: code === "DESTINATION_NOT_DIRECTORY"
        ? "所选目标位置不是可用文件夹。"
        : "无法确认文件和目标位置，请重新扫描后再试。",
    };
  }
}

function nodeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

async function registerFileProtocol(): Promise<void> {
  await protocol.handle(REGISTERED_FILE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "preview") return new Response(null, { status: 404 });
      const fileId = parseFileId(url.pathname.slice(1));
      const preview = await (await manager()).getRegisteredPreview(fileId);
      if (!preview) return new Response(null, { status: 404 });
      const source = await net.fetch(pathToFileURL(preview.absolutePath).toString(), { headers: request.headers });
      const headers = new Headers(source.headers);
      headers.set("Content-Type", preview.mimeType);
      headers.set("Content-Disposition", "inline");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.jianyingProtection, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return jianyingSnapshot();
  });
  ipcMain.handle(IPC_CHANNELS.chooseJianyingDirectory, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    const chosen = await dialog.showOpenDialog(mainWindow!, { title: "选择剪映草稿根目录（只读）", properties: ["openDirectory"] });
    if (!chosen.canceled && chosen.filePaths[0]) {
      const directory = path.resolve(chosen.filePaths[0]);
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink() || path.resolve(await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("请选择本地普通草稿目录");
      await writeFile(path.join(app.getPath("userData"), "jianying-root.json"), JSON.stringify({ directory }), "utf8");
    }
    return jianyingSnapshot();
  });
  // Favorites are app metadata, never a filesystem operation. Paths come only
  // from the current registry; identity signals prevent obvious path reuse.
  async function favoriteIdentity(current: WatchDirectoryManager, id: string, root: string | null) {
    const filePath = await current.getRegisteredActionPath(id);
    if (!filePath || !root || current.getState().directory !== root) return null;
    const metadata = await lstat(filePath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    if (current.getState().directory !== root) return null;
    return { filePath, token: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}` };
  }
  ipcMain.handle(IPC_CHANNELS.favoriteFileIds, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    const current = await manager(), root = current.getState().directory;
    const rows = root ? operationsDatabase!.prepare("SELECT file_id, file_path, identity_token FROM file_favorites WHERE watched_root = ?").all(root) as { file_id: string; file_path: string; identity_token: string }[] : [];
    const fileIds: string[] = [];
    for (const row of rows) {
      try {
        const inspected = await favoriteIdentity(current, row.file_id, root);
        if (inspected?.filePath === row.file_path && inspected.token === row.identity_token) fileIds.push(row.file_id);
      } catch { /* A missing or inaccessible favorite is not a whole-list error. */ }
    }
    return parseFavoriteSnapshot({ directory: root, fileIds });
  });
  ipcMain.handle(IPC_CHANNELS.setFileFavorite, async (event, ...args) => {
    assertTrustedRequest(event, args, 2);
    const fileId = parseFileId(args[0]), favorite = parseFavoriteFlag(args[1]);
    try {
      const current = await manager(), root = current.getState().directory;
      const inspected = await favoriteIdentity(current, fileId, root);
      if (!inspected) return parseFavoriteResult({ ok: false, code: "file_unavailable", message: "文件已不可用，收藏未更改", fileId, favorite });
      if (favorite) {
        operationsDatabase!.prepare(`INSERT INTO file_favorites (file_id, watched_root, file_path, identity_token, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET watched_root=excluded.watched_root,
          file_path=excluded.file_path, identity_token=excluded.identity_token`).run(fileId, root, inspected.filePath, inspected.token, new Date().toISOString());
      } else {
        operationsDatabase!.prepare("DELETE FROM file_favorites WHERE file_id = ? AND watched_root = ?").run(fileId, root);
      }
      return parseFavoriteResult({ ok: true, code: null, message: favorite ? "已收藏" : "已取消收藏", fileId, favorite });
    } catch (error) {
      console.warn(`[Sorttie] 收藏保存失败 (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
      return parseFavoriteResult({ ok: false, code: "favorite_save_failed", message: "收藏保存失败，请稍后重试", fileId, favorite });
    }
  });
  ipcMain.handle(IPC_CHANNELS.appInfo, (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return parseAppInfo({ name: "Sorttie", version: app.getVersion(), readOnly: false, platform: process.platform });
  });

  ipcMain.handle(IPC_CHANNELS.chooseWatchDirectory, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    const currentManager = await manager();
    const options: Electron.OpenDialogOptions = {
      title: "选择监控文件夹",
      buttonLabel: "开始监控",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length !== 1) {
      return parseChooseResult({ cancelled: true, snapshot: currentManager.getSnapshot("directory-change") });
    }
    const snapshot = await currentManager.setDirectory(result.filePaths[0]);
    return parseChooseResult({ cancelled: false, snapshot });
  });

  ipcMain.handle(IPC_CHANNELS.watchDirectoryState, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return parseWatchDirectoryState((await manager()).getState());
  });

  ipcMain.handle(IPC_CHANNELS.currentFiles, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return parseFileRecords((await manager()).getFiles());
  });

  ipcMain.handle(IPC_CHANNELS.rescan, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return parseFileSnapshot(await (await manager()).rescan());
  });

  ipcMain.handle(IPC_CHANNELS.imageThumbnail, async (event, ...args) => {
    assertTrustedRequest(event, args, 1);
    const fileId = parseFileId(args[0]);
    const imagePath = await (await manager()).getRegisteredImagePath(fileId);
    if (!imagePath) return null;
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(imagePath, { width: 640, height: 360 });
      return parseThumbnail(thumbnail.isEmpty() ? null : thumbnail.toDataURL());
    } catch (error) {
      console.warn(`[Sorttie] 无法生成图片缩略图 (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
      return null;
    }
  });

  for (const action of FILE_ACTIONS) {
    const channel = action === "open"
      ? IPC_CHANNELS.openFile
      : action === "open-with"
        ? IPC_CHANNELS.openWith
        : action === "show-in-folder"
          ? IPC_CHANNELS.showItemInFolder
          : action === "copy-file-path"
            ? IPC_CHANNELS.copyFilePath
            : IPC_CHANNELS.copyFolderPath;
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedRequest(event, args, 1);
      return performFileAction(action, parseFileId(args[0]));
    });
  }

  ipcMain.handle(IPC_CHANNELS.textPreview, async (event, ...args) => {
    assertTrustedRequest(event, args, 1);
    const preview = await (await manager()).readRegisteredTextPreview(parseFileId(args[0]));
    return parseTextPreview(preview);
  });

  ipcMain.handle(IPC_CHANNELS.localAiClassification, async (event, ...args) => {
    assertTrustedRequest(event, args, 1);
    const fileId = parseFileId(args[0]);
    const current = await manager();
    const file = current.getFiles().find((candidate) => candidate.id === fileId);
    const registeredPath = await current.getRegisteredActionPath(fileId);
    if (!file || !registeredPath || path.resolve(file.absolutePath) !== path.resolve(registeredPath)) {
      return parseLocalAiClassificationResult({
        status: "unavailable",
        fileId,
        model: null,
        code: "file_unavailable",
        message: "文件已不在监控目录中，请重新扫描后再试。",
      });
    }
    let textContent: string | null = null;
    if (file.previewCapability === "text") {
      try {
        textContent = (await current.readRegisteredTextPreview(fileId, 8 * 1024))?.text ?? null;
      } catch {
        // Metadata-only classification remains useful when a single text read fails.
      }
    }
    return parseLocalAiClassificationResult(await localAiClassifier.classify({
      fileId,
      name: file.name,
      extension: file.extension,
      directoryName: path.basename(file.parentDirectory) || file.parentDirectory,
      sizeBytes: file.sizeBytes,
      textContent,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.prepareOrganizationPlan, async (event, ...args) => {
    assertTrustedRequest(event, args, 2);
    return parseOrganizationPreparationResult(await prepareOrganizationPlan(
      parseOrganizationPlanRequest(args[0]),
      parseOrganizationDestinationMode(args[1]),
    ));
  });

  ipcMain.handle(IPC_CHANNELS.organizationRoot, async (event, ...args) => {
    assertTrustedRequest(event, args, 0);
    return parseOrganizationRoot(await getOrganizationRoot());
  });

  ipcMain.handle(IPC_CHANNELS.executeOrganization, async (event, ...args) => {
    assertTrustedRequest(event, args, 1);
    const operationId = parseOperationId(args[0]) as OperationId;
    return parseOrganizationActionResult(await operationService().execute(operationId));
  });

  ipcMain.handle(IPC_CHANNELS.undoOrganization, async (event, ...args) => {
    assertTrustedRequest(event, args, 1);
    const operationId = parseOperationId(args[0]) as OperationId;
    return parseOrganizationActionResult(await operationService().undo(operationId));
  });

  ipcMain.on(IPC_CHANNELS.startFileDrag, (event, ...args) => {
    let fileId: string;
    try {
      assertTrustedEvent(event, args, 1);
      fileId = parseFileId(args[0]);
    } catch {
      console.warn("[Sorttie] 已拒绝无效的文件拖拽请求");
      return;
    }
    void (async () => {
      const filePath = await (await manager()).getRegisteredActionPath(fileId);
      if (!filePath || event.sender.isDestroyed() || useMockFileActions) return;
      try {
        const icon = await app.getFileIcon(filePath, { size: "normal" });
        if (!event.sender.isDestroyed() && !icon.isEmpty()) event.sender.startDrag({ file: filePath, icon });
      } catch (error) {
        console.warn(`[Sorttie] 无法开始文件拖拽 (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
      }
    })();
  });
}

async function createWindow(): Promise<void> {
  const { width, height } = await initialWindowSize();

  const window = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 540,
    useContentSize: true,
    show: false,
    backgroundColor: "#f6f3ee",
    title: "Sorttie",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = window;

  let persistTimer: NodeJS.Timeout | null = null;
  const persistSize = () => {
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    const bounds = window.getContentBounds();
    void writeFile(path.join(app.getPath("userData"), windowStateFile), JSON.stringify({ width: bounds.width, height: bounds.height }), "utf8")
      .catch(() => console.warn("[Sorttie] 无法保存窗口尺寸"));
  };
  window.on("resize", () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistSize, 250);
  });
  window.on("close", persistSize);

  const indexPath = path.join(__dirname, "../../dist-renderer/index.html");
  void window.loadFile(indexPath);

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });

  window.once("ready-to-show", () => {
    window.show();
    if (process.env.SORTTIE_DEMO_MAXIMIZED === "1") {
      window.maximize();
    } else {
      window.center();
    }
  });

  window.on("closed", () => {
    if (persistTimer) clearTimeout(persistTimer);
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  operationsDatabase = openSorttieDatabase(path.join(app.getPath("userData"), "sorttie.sqlite"));
  planStore = new OrganizationPlanStore(operationsDatabase);
  localFileOperations = new LocalFileOperationService(planStore, operationsDatabase, undefined, async (sourcePath) => {
    const scan = await currentJianyingScan();
    return protectionConclusion(fileProtection(scan, "", sourcePath));
  });
  watchManager = new WatchDirectoryManager(app.getPath("userData"));
  watchManagerReady = watchManager.initialize();
  watchManager.subscribe((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.fileChanges, parseFileChangeEvent(event));
    }
  });
  registerIpcHandlers();
  void registerFileProtocol();

  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (!watchManager || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void watchManager.dispose().finally(() => {
    operationsDatabase?.close();
    operationsDatabase = null;
    planStore = null;
    localFileOperations = null;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
