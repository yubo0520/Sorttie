import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  parseJianyingSnapshot,
  parseLocalAiClassificationResult,
  parseAppInfo,
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
  type SorttieApi,
} from "../shared/contracts";

const api: SorttieApi = Object.freeze({
  async getJianyingProtection() { return parseJianyingSnapshot(await ipcRenderer.invoke(IPC_CHANNELS.jianyingProtection)); },
  async chooseJianyingDirectory() { return parseJianyingSnapshot(await ipcRenderer.invoke(IPC_CHANNELS.chooseJianyingDirectory)); },
  async getAppInfo() {
    return parseAppInfo(await ipcRenderer.invoke(IPC_CHANNELS.appInfo));
  },
  async chooseWatchDirectory() {
    return parseChooseResult(await ipcRenderer.invoke(IPC_CHANNELS.chooseWatchDirectory));
  },
  async getWatchDirectoryState() {
    return parseWatchDirectoryState(await ipcRenderer.invoke(IPC_CHANNELS.watchDirectoryState));
  },
  async getCurrentFiles() {
    return parseFileRecords(await ipcRenderer.invoke(IPC_CHANNELS.currentFiles));
  },
  async getFavoriteFileIds() {
    return parseFavoriteSnapshot(await ipcRenderer.invoke(IPC_CHANNELS.favoriteFileIds));
  },
  async setFileFavorite(fileId: string, favorite: boolean) {
    return parseFavoriteResult(await ipcRenderer.invoke(IPC_CHANNELS.setFileFavorite, parseFileId(fileId), parseFavoriteFlag(favorite)));
  },
  async rescanWatchDirectory() {
    return parseFileSnapshot(await ipcRenderer.invoke(IPC_CHANNELS.rescan));
  },
  async getImageThumbnail(fileId: string) {
    return parseThumbnail(await ipcRenderer.invoke(IPC_CHANNELS.imageThumbnail, parseFileId(fileId)));
  },
  async openFile(fileId: string) {
    return parseFileActionResult(await ipcRenderer.invoke(IPC_CHANNELS.openFile, parseFileId(fileId)));
  },
  async openWith(fileId: string) {
    return parseFileActionResult(await ipcRenderer.invoke(IPC_CHANNELS.openWith, parseFileId(fileId)));
  },
  async showItemInFolder(fileId: string) {
    return parseFileActionResult(await ipcRenderer.invoke(IPC_CHANNELS.showItemInFolder, parseFileId(fileId)));
  },
  async copyFilePath(fileId: string) {
    return parseFileActionResult(await ipcRenderer.invoke(IPC_CHANNELS.copyFilePath, parseFileId(fileId)));
  },
  async copyFolderPath(fileId: string) {
    return parseFileActionResult(await ipcRenderer.invoke(IPC_CHANNELS.copyFolderPath, parseFileId(fileId)));
  },
  startFileDrag(fileId: string) {
    ipcRenderer.send(IPC_CHANNELS.startFileDrag, parseFileId(fileId));
  },
  async readTextPreview(fileId: string) {
    return parseTextPreview(await ipcRenderer.invoke(IPC_CHANNELS.textPreview, parseFileId(fileId)));
  },
  async classifyFileWithLocalAi(fileId: string) {
    return parseLocalAiClassificationResult(await ipcRenderer.invoke(
      IPC_CHANNELS.localAiClassification,
      parseFileId(fileId),
    ));
  },
  async getOrganizationRoot() {
    return parseOrganizationRoot(await ipcRenderer.invoke(IPC_CHANNELS.organizationRoot));
  },
  async prepareOrganizationPlan(items, mode = "categorized") {
    return parseOrganizationPreparationResult(await ipcRenderer.invoke(
      IPC_CHANNELS.prepareOrganizationPlan,
      parseOrganizationPlanRequest(items),
      parseOrganizationDestinationMode(mode),
    ));
  },
  async executeOrganization(operationId) {
    return parseOrganizationActionResult(await ipcRenderer.invoke(
      IPC_CHANNELS.executeOrganization,
      parseOperationId(operationId),
    ));
  },
  async undoOrganization(operationId) {
    return parseOrganizationActionResult(await ipcRenderer.invoke(
      IPC_CHANNELS.undoOrganization,
      parseOperationId(operationId),
    ));
  },
  subscribeToFileChanges(listener) {
    if (typeof listener !== "function") throw new TypeError("File-change listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(parseFileChangeEvent(value));
    ipcRenderer.on(IPC_CHANNELS.fileChanges, handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener(IPC_CHANNELS.fileChanges, handler);
    };
  },
});

contextBridge.exposeInMainWorld("sorttie", api);
