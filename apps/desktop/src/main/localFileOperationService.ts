import { lstat, mkdir, realpath, rename, rmdir } from "node:fs/promises";
import { win32 as path } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  FileIdentitySnapshot,
  OperationId,
  ProtectionConclusion,
} from "./organizationPlan.js";
import {
  OrganizationPlanStore,
  type OperationContext,
} from "./organizationPlanStore.js";

export type FileInspection = Readonly<{
  path: string;
  status: "present" | "missing" | "failed";
  exists: boolean | null;
  isRegularFile: boolean;
  isDirectory: boolean;
  isLinkOrReparsePoint: boolean;
  size: string | null;
  mtimeNs: string | null;
  birthtimeNs: string | null;
  dev: string | null;
  ino: string | null;
  identityAvailable: boolean;
  errorCode: string | null;
}>;

export type DestinationInspection = Readonly<{
  path: string;
  parentPath: string;
  parent: FileInspection;
  target: FileInspection;
  hasConflict: boolean;
}>;

export const PREFLIGHT_BLOCK_CODES = [
  "operation_not_found",
  "operation_not_prepared",
  "plan_not_frozen",
  "source_missing",
  "source_outside_managed_root",
  "source_not_first_level",
  "source_not_regular_file",
  "source_is_link",
  "source_identity_changed",
  "source_equals_destination",
  "destination_parent_missing",
  "destination_parent_not_directory",
  "destination_conflict_changed",
  "conflict_policy_not_executable",
  "protection_blocked",
  "risk_confirmation_missing",
  "inspection_failed",
] as const;

export type PreflightBlockCode = (typeof PREFLIGHT_BLOCK_CODES)[number];

export type PreflightBlockReason = Readonly<{
  code: PreflightBlockCode;
  path?: string;
  detail?: string;
}>;

export type OperationInspectionResult =
  | Readonly<{
      status: "inspected";
      operationId: OperationId;
      source: FileInspection;
      destination: DestinationInspection;
    }>
  | Readonly<{
      status: "blocked";
      operationId: string;
      reasons: readonly PreflightBlockReason[];
    }>;

export type PreflightResult =
  | Readonly<{
      status: "ready";
      operationId: OperationId;
      source: FileInspection;
      destination: DestinationInspection;
    }>
  | Readonly<{
      status: "blocked";
      operationId: string;
      reasons: readonly PreflightBlockReason[];
    }>;

export type FileOperationResult = Readonly<{
  status: "moved" | "undone" | "blocked" | "failed";
  operationId: string;
  code: string | null;
  message: string;
}>;

type MoveReceipt = Readonly<{
  kind: "same_volume_move_receipt";
  sourcePath: string;
  destinationPath: string;
  destinationIdentity: FileIdentitySnapshot;
}>;

type RenameFile = (sourcePath: string, destinationPath: string) => Promise<void>;

type DirectoryPolicy = {
  rootPath: string;
  rootDev: string;
  rootIno: string;
  rootBirthtimeNs: string;
  directoryPath: string;
  existed: boolean;
};

export class LocalFileOperationService {
  constructor(
    private readonly plans: OrganizationPlanStore,
    private readonly database: DatabaseSync,
    private readonly renameFile: RenameFile = rename,
    private readonly checkProtection?: (sourcePath: string) => Promise<ProtectionConclusion>,
  ) {}

  async inspect(operationId: OperationId): Promise<OperationInspectionResult> {
    let context: OperationContext | null;
    try {
      context = this.plans.loadOperationContext(operationId);
    } catch {
      return blocked(operationId, [{
        code: "inspection_failed",
        detail: "operation_context_unavailable",
      }]);
    }
    if (!context) {
      return blocked(operationId, [{ code: "operation_not_found" }]);
    }

    const locationReason = sourceLocationReason(
      context.watchedRoot,
      context.item.sourcePath,
    );
    if (locationReason) {
      return blocked(operationId, [locationReason]);
    }

    const inspection = await inspectContext(context);
    return Object.freeze({
      status: "inspected",
      operationId,
      ...inspection,
    });
  }

  async preflight(operationId: OperationId): Promise<PreflightResult> {
    let context: OperationContext | null;
    try {
      context = this.plans.loadOperationContext(operationId);
    } catch {
      return blocked(operationId, [{
        code: "inspection_failed",
        detail: "operation_context_unavailable",
      }]);
    }
    if (!context) {
      return blocked(operationId, [{ code: "operation_not_found" }]);
    }

    const reasons: PreflightBlockReason[] = [];
    if (context.operation.phase !== "prepared") {
      reasons.push({ code: "operation_not_prepared" });
    }
    if (context.planState !== "frozen") {
      reasons.push({ code: "plan_not_frozen" });
    }
    if (!operationMatchesFrozenItem(context)) {
      reasons.push({
        code: "inspection_failed",
        detail: "The persisted operation no longer matches its frozen plan item.",
      });
    }

    const locationReason = sourceLocationReason(
      context.watchedRoot,
      context.item.sourcePath,
    );
    if (locationReason) {
      reasons.push(locationReason);
    }
    if (sameWindowsPath(context.item.sourcePath, context.item.destinationPath)) {
      reasons.push({
        code: "source_equals_destination",
        path: context.item.sourcePath,
      });
    }
    if (context.item.protection.level === "strong_block") {
      reasons.push({ code: "protection_blocked" });
    }
    if (
      context.item.protection.level === "weak_warning"
      && !context.item.riskAccepted
    ) {
      reasons.push({ code: "risk_confirmation_missing" });
    }

    if (reasons.length > 0) {
      return blocked(operationId, reasons);
    }

    if (this.checkProtection) {
      try {
        const current = await this.checkProtection(context.item.sourcePath);
        if (current.level === "strong_block") return blocked(operationId, [{ code: "protection_blocked", detail: "剪映当前时间线正在引用，文件未移动。" }]);
        if (current.level === "weak_warning" && (!context.item.riskAccepted || JSON.stringify(current.evidence) !== JSON.stringify(context.item.protection.evidence))) {
          return blocked(operationId, [{ code: "risk_confirmation_missing", detail: "剪映备份引用尚未确认或已变化，请返回重新确认。" }]);
        }
      } catch { return blocked(operationId, [{ code: "inspection_failed", detail: "剪映保护检查失败，请重试。" }]); }
    }

    const inspection = await inspectContext(context);
    let allowMissingParent = false;
    try {
      const policy = this.directoryPolicy(context);
      if (policy) {
        const root = await inspectPath(policy.rootPath);
        if (root.status !== "present" || !root.isDirectory || root.isLinkOrReparsePoint
          || !sameWindowsPath(await realpath(policy.rootPath), policy.rootPath)
          || root.birthtimeNs !== policy.rootBirthtimeNs
          || (policy.rootIno !== "0" && (root.ino !== policy.rootIno || root.dev !== policy.rootDev))) {
          reasons.push({ code: "inspection_failed", detail: "organization_root_changed" });
        }
        allowMissingParent = !policy.existed && root.status === "present";
      }
    } catch {
      reasons.push({ code: "inspection_failed", detail: "invalid_directory_policy" });
    }
    inspectSource(
      inspection.source,
      context.item.sourceIdentity,
      reasons,
    );
    inspectDestination(
      inspection.destination,
      context.item.conflictPolicy,
      reasons,
      allowMissingParent,
    );

    if (reasons.length > 0) {
      return blocked(operationId, reasons);
    }

    return Object.freeze({
      status: "ready",
      operationId,
      ...inspection,
    });
  }

  async execute(operationId: OperationId): Promise<FileOperationResult> {
    const preflight = await this.preflight(operationId);
    if (preflight.status === "blocked") {
      return resultForPreflightBlock(operationId, preflight.reasons);
    }

    let context: OperationContext | null;
    try {
      context = this.plans.loadOperationContext(operationId);
    } catch {
      return operationResult("failed", operationId, "inspection_failed", "无法读取冻结计划，文件未移动。");
    }
    if (!context) {
      return operationResult("blocked", operationId, "operation_not_found", "找不到这次整理操作，请重新生成整理预览。");
    }
    if (
      context.operation.strategy !== "same_volume_rename"
      || !sameVolume(preflight.source, preflight.destination.parent.status === "missing"
        ? await inspectPath(this.directoryPolicy(context)!.rootPath)
        : preflight.destination.parent)
    ) {
      return operationResult("blocked", operationId, "cross_volume_unsupported", "当前版本暂不支持跨盘整理");
    }

    try {
      const policy = this.directoryPolicy(context);
      if (policy && preflight.destination.parent.status === "missing") {
        this.appendEvent(operationId, "directory_creating", policy);
        try {
          await mkdir(policy.directoryPath);
          const created = await inspectPath(policy.directoryPath);
          if (created.status !== "present" || !created.isDirectory || created.isLinkOrReparsePoint) throw new Error("Directory creation could not be verified");
          this.appendEvent(operationId, "directory_created", {
            directoryPath: policy.directoryPath,
            dev: created.dev, ino: created.ino, birthtimeNs: created.birthtimeNs,
          });
        } catch (error) {
          if (nodeErrorCode(error) !== "EEXIST") throw error;
        }
      }
      // Creating a parent is a separate side effect; recheck the file and destination before moving.
      const finalCheck = await this.preflight(operationId);
      if (finalCheck.status === "blocked") return resultForPreflightBlock(operationId, finalCheck.reasons);
      if (finalCheck.destination.parent.status !== "present" || !sameVolume(finalCheck.source, finalCheck.destination.parent)) {
        return operationResult("blocked", operationId, "destination_parent_missing", "分类目录已变化，文件未移动。");
      }
    } catch {
      return operationResult("failed", operationId, "directory_creation_failed", "无法安全创建或记录分类目录，文件未移动。");
    }

    try {
      this.transitionPhase(operationId, "prepared", "moving", {
        strategy: "same_volume_rename",
      });
    } catch {
      return operationResult("failed", operationId, "journal_failed", "无法安全记录整理开始状态，文件未移动。");
    }

    try {
      await this.renameFile(context.operation.sourcePath, context.operation.destinationPath);
    } catch (error) {
      const code = nodeErrorCode(error);
      this.tryTransitionFailure(operationId, "moving", "failed", {
        code,
        stage: "rename",
      });
      const destination = await inspectPath(context.operation.destinationPath);
      if (destination.status === "present") {
        return operationResult("blocked", operationId, "destination_conflict_changed", "目标位置已有同名文件，未执行整理。");
      }
      return operationResult("failed", operationId, "move_failed", "文件移动失败，原文件仍保留在原位置。");
    }

    const [sourceAfter, destinationAfter] = await Promise.all([
      inspectPath(context.operation.sourcePath),
      inspectPath(context.operation.destinationPath),
    ]);
    if (
      sourceAfter.status !== "missing"
      || destinationAfter.status !== "present"
      || !destinationAfter.isRegularFile
      || destinationAfter.isLinkOrReparsePoint
      || !identityMatches(toIdentitySnapshot(preflight.source), destinationAfter)
    ) {
      this.tryTransitionFailure(operationId, "moving", "manual_review", {
        stage: "verify_destination",
      });
      return operationResult("failed", operationId, "move_verification_failed", "文件已发生变化，但移动结果无法确认，请手动检查原位置和目标位置。");
    }

    const receipt: MoveReceipt = Object.freeze({
      kind: "same_volume_move_receipt",
      sourcePath: context.operation.sourcePath,
      destinationPath: context.operation.destinationPath,
      destinationIdentity: toIdentitySnapshot(destinationAfter),
    });
    try {
      this.transitionPhase(operationId, "moving", "completed", receipt);
    } catch {
      return operationResult("failed", operationId, "journal_failed", "文件已移动，但完成状态未能安全保存，请不要重复操作。");
    }
    return operationResult("moved", operationId, null, "整理完成，可以撤销本次移动。");
  }

  async undo(operationId: OperationId): Promise<FileOperationResult> {
    let context: OperationContext | null;
    try {
      context = this.plans.loadOperationContext(operationId);
    } catch {
      return operationResult("blocked", operationId, "operation_not_found", "找不到这次整理操作，无法撤销。");
    }
    if (!context || context.operation.phase !== "completed") {
      return operationResult("blocked", operationId, "undo_not_available", "这次整理当前不能撤销。");
    }
    if (this.hasEvent(operationId, "undone")) {
      return operationResult("blocked", operationId, "undo_not_available", "这次整理已经撤销。");
    }
    const receipt = this.loadMoveReceipt(operationId);
    if (!receipt
      || !sameWindowsPath(receipt.sourcePath, context.operation.sourcePath)
      || !sameWindowsPath(receipt.destinationPath, context.operation.destinationPath)) {
      return operationResult("blocked", operationId, "undo_not_available", "缺少可验证的移动记录，无法安全撤销。");
    }

    const sourceParentPath = path.dirname(receipt.sourcePath);
    const [source, destination, sourceParent] = await Promise.all([
      inspectPath(receipt.sourcePath),
      inspectPath(receipt.destinationPath),
      inspectPath(sourceParentPath),
    ]);
    if (source.status === "present") {
      return operationResult("blocked", operationId, "undo_source_occupied", "原位置已经存在同名文件，无法撤销。");
    }
    if (source.status === "failed") {
      return operationResult("blocked", operationId, "inspection_failed", "无法确认原位置状态，未执行撤销。");
    }
    if (destination.status === "missing") {
      return operationResult("blocked", operationId, "undo_destination_missing", "移动后的文件已经不在目标位置，无法撤销。");
    }
    if (
      destination.status === "failed"
      || !destination.isRegularFile
      || destination.isLinkOrReparsePoint
      || !identityMatches(receipt.destinationIdentity, destination)
    ) {
      return operationResult("blocked", operationId, "undo_destination_changed", "目标文件已经变化，无法确认它仍是刚才移动的文件。");
    }
    if (
      sourceParent.status !== "present"
      || !sourceParent.isDirectory
      || sourceParent.isLinkOrReparsePoint
    ) {
      return operationResult("blocked", operationId, "undo_source_parent_missing", "原文件夹当前不可用，无法撤销。");
    }
    if (!sameVolume(destination, sourceParent)) {
      return operationResult("blocked", operationId, "cross_volume_unsupported", "当前版本暂不支持跨盘整理");
    }

    try {
      this.appendEvent(operationId, "undo_moving", {
        sourcePath: receipt.destinationPath,
        destinationPath: receipt.sourcePath,
      });
    } catch {
      return operationResult("failed", operationId, "journal_failed", "无法安全记录撤销开始状态，文件未移动。");
    }

    try {
      await this.renameFile(receipt.destinationPath, receipt.sourcePath);
    } catch (error) {
      this.tryAppendEvent(operationId, "undo_failed", {
        code: nodeErrorCode(error),
        stage: "rename",
      });
      return operationResult("failed", operationId, "undo_failed", "撤销失败，文件仍保留在整理后的目标位置。");
    }

    const [restored, destinationAfter] = await Promise.all([
      inspectPath(receipt.sourcePath),
      inspectPath(receipt.destinationPath),
    ]);
    if (
      restored.status !== "present"
      || destinationAfter.status !== "missing"
      || !identityMatches(receipt.destinationIdentity, restored)
    ) {
      this.tryAppendEvent(operationId, "undo_failed", { stage: "verify_restored_source" });
      return operationResult("failed", operationId, "undo_failed", "文件已发生变化，但撤销结果无法确认，请手动检查两个位置。");
    }

    try {
      this.appendEvent(operationId, "undone", {
        restoredPath: receipt.sourcePath,
        restoredIdentity: toIdentitySnapshot(restored),
      });
    } catch {
      return operationResult("failed", operationId, "journal_failed", "文件已移回原位置，但撤销记录未能安全保存。");
    }
    const retainedDirectory = await this.cleanupCreatedDirectories(context);
    return operationResult("undone", operationId, null, retainedDirectory
      ? "文件已回到原位置；非空、已变化或无法安全清理的分类目录已保留。"
      : "已撤销，文件已回到原位置。");
  }

  private directoryPolicy(context: OperationContext): DirectoryPolicy | null {
    const row = this.database.prepare("SELECT details_json FROM operation_events WHERE operation_id = ? AND phase = 'directory_planned' ORDER BY event_id LIMIT 1")
      .get(context.operation.operationId) as { details_json: string } | undefined;
    if (!row) return null;
    const policy = JSON.parse(row.details_json) as DirectoryPolicy;
    if (typeof policy.rootPath !== "string" || !path.isAbsolute(policy.rootPath)
      || typeof policy.directoryPath !== "string" || typeof policy.existed !== "boolean"
      || typeof policy.rootDev !== "string" || typeof policy.rootIno !== "string" || typeof policy.rootBirthtimeNs !== "string"
      || context.item.category === "其他"
      || !sameWindowsPath(policy.directoryPath, path.join(policy.rootPath, context.item.category))
      || !sameWindowsPath(policy.directoryPath, path.dirname(context.item.destinationPath))) {
      throw new Error("Directory policy does not match the frozen destination");
    }
    return policy;
  }

  private async cleanupCreatedDirectories(context: OperationContext): Promise<boolean> {
    let retained = false;
    // Plan scope lets the last undo clean a shared folder even when another operation created it.
    const rows = this.database.prepare(`SELECT e.operation_id, e.details_json FROM operation_events e
      JOIN operations o ON o.operation_id = e.operation_id
      WHERE o.plan_id = ? AND e.phase = 'directory_created' ORDER BY e.event_id DESC`)
      .all(context.operation.planId) as { operation_id: OperationId; details_json: string }[];
    for (const row of rows) {
      try {
        const creator = this.plans.loadOperationContext(row.operation_id);
        if (!creator) continue;
        const policy = this.directoryPolicy(creator);
        const receipt = JSON.parse(row.details_json) as { directoryPath: string; dev: string | null; ino: string | null; birthtimeNs: string | null };
        if (!policy || policy.existed || !sameWindowsPath(receipt.directoryPath, policy.directoryPath)) continue;
        const current = await inspectPath(policy.directoryPath);
        if (current.status === "missing") continue;
        // Directory mtime/size change as files move; compare its available identity instead.
        if (current.status !== "present" || !current.isDirectory || current.isLinkOrReparsePoint
          || !receipt.ino || !receipt.dev || current.ino !== receipt.ino || current.dev !== receipt.dev
          || current.birthtimeNs !== receipt.birthtimeNs
          || !sameWindowsPath(await realpath(policy.directoryPath), policy.directoryPath)) {
          retained = true;
          continue;
        }
        await rmdir(policy.directoryPath); // Non-recursive: an occupied directory is always retained.
        this.tryAppendEvent(context.operation.operationId, "directory_removed", { directoryPath: policy.directoryPath });
      } catch {
        retained = true;
      }
    }
    return retained;
  }

  private transitionPhase(
    operationId: OperationId,
    expected: string,
    next: string,
    details: object,
  ): void {
    const recordedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database.prepare(`
        UPDATE operations SET phase = ?, updated_at = ?
        WHERE operation_id = ? AND phase = ?
      `).run(next, recordedAt, operationId, expected);
      if (Number(updated.changes) !== 1) {
        throw new Error("Operation phase changed before transition.");
      }
      this.database.prepare(`
        INSERT INTO operation_events (operation_id, phase, recorded_at, details_json)
        VALUES (?, ?, ?, ?)
      `).run(operationId, next, recordedAt, JSON.stringify(details));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEvent(operationId: OperationId, phase: string, details: object): void {
    this.database.prepare(`
      INSERT INTO operation_events (operation_id, phase, recorded_at, details_json)
      VALUES (?, ?, ?, ?)
    `).run(operationId, phase, new Date().toISOString(), JSON.stringify(details));
  }

  private tryTransitionFailure(operationId: OperationId, expected: string, next: string, details: object): void {
    try {
      this.transitionPhase(operationId, expected, next, details);
    } catch {
      // The returned result still reports that the side effect could not be confirmed.
    }
  }

  private tryAppendEvent(operationId: OperationId, phase: string, details: object): void {
    try {
      this.appendEvent(operationId, phase, details);
    } catch {
      // The original filesystem error remains the actionable result.
    }
  }

  private hasEvent(operationId: OperationId, phase: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM operation_events
      WHERE operation_id = ? AND phase = ? LIMIT 1
    `).get(operationId, phase) as { found: number } | undefined;
    return row?.found === 1;
  }

  private loadMoveReceipt(operationId: OperationId): MoveReceipt | null {
    const row = this.database.prepare(`
      SELECT details_json FROM operation_events
      WHERE operation_id = ? AND phase = 'completed'
      ORDER BY event_id DESC LIMIT 1
    `).get(operationId) as { details_json: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.details_json) as Partial<MoveReceipt>;
      if (value.kind !== "same_volume_move_receipt"
        || typeof value.sourcePath !== "string"
        || typeof value.destinationPath !== "string"
        || !isIdentitySnapshot(value.destinationIdentity)) {
        return null;
      }
      return value as MoveReceipt;
    } catch {
      return null;
    }
  }
}

async function inspectContext(context: OperationContext): Promise<{
  source: FileInspection;
  destination: DestinationInspection;
}> {
  const destinationParentPath = path.dirname(context.item.destinationPath);
  const [source, destinationParent, destinationTarget] = await Promise.all([
    inspectPath(context.item.sourcePath),
    inspectPath(destinationParentPath),
    inspectPath(context.item.destinationPath),
  ]);

  return {
    source,
    destination: Object.freeze({
      path: context.item.destinationPath,
      parentPath: destinationParentPath,
      parent: destinationParent,
      target: destinationTarget,
      hasConflict: destinationTarget.status === "present",
    }),
  };
}

async function inspectPath(absolutePath: string): Promise<FileInspection> {
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    const identityAvailable = stats.dev !== 0n && stats.ino !== 0n;
    return Object.freeze({
      path: absolutePath,
      status: "present",
      exists: true,
      isRegularFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isLinkOrReparsePoint: stats.isSymbolicLink(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      birthtimeNs: stats.birthtimeNs.toString(),
      dev: identityAvailable ? stats.dev.toString() : null,
      ino: identityAvailable ? stats.ino.toString() : null,
      identityAvailable,
      errorCode: null,
    });
  } catch (error) {
    const errorCode = nodeErrorCode(error);
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
      return absentInspection(absolutePath, "missing", errorCode);
    }
    return absentInspection(absolutePath, "failed", errorCode);
  }
}

function inspectSource(
  source: FileInspection,
  expected: FileIdentitySnapshot,
  reasons: PreflightBlockReason[],
): void {
  if (source.status === "missing") {
    reasons.push({ code: "source_missing", path: source.path });
    return;
  }
  if (source.status === "failed") {
    reasons.push({
      code: "inspection_failed",
      path: source.path,
      detail: source.errorCode ?? "UNKNOWN",
    });
    return;
  }
  if (source.isLinkOrReparsePoint) {
    reasons.push({ code: "source_is_link", path: source.path });
    return;
  }
  if (!source.isRegularFile) {
    reasons.push({ code: "source_not_regular_file", path: source.path });
    return;
  }
  if (!identityMatches(expected, source)) {
    reasons.push({ code: "source_identity_changed", path: source.path });
  }
}

function inspectDestination(
  destination: DestinationInspection,
  conflictPolicy: OperationContext["item"]["conflictPolicy"],
  reasons: PreflightBlockReason[],
  allowMissingParent = false,
): void {
  if (destination.parent.status === "missing" && !allowMissingParent) {
    reasons.push({
      code: "destination_parent_missing",
      path: destination.parentPath,
    });
  } else if (destination.parent.status === "failed") {
    reasons.push({
      code: "inspection_failed",
      path: destination.parentPath,
      detail: destination.parent.errorCode ?? "UNKNOWN",
    });
  } else if (destination.parent.status === "present" && (
    !destination.parent.isDirectory
    || destination.parent.isLinkOrReparsePoint
  )) {
    reasons.push({
      code: "destination_parent_not_directory",
      path: destination.parentPath,
    });
  }

  if (destination.target.status === "failed") {
    reasons.push({
      code: "inspection_failed",
      path: destination.path,
      detail: destination.target.errorCode ?? "UNKNOWN",
    });
    return;
  }

  if (conflictPolicy === "skip") {
    if (destination.hasConflict) {
      reasons.push({
        code: "conflict_policy_not_executable",
        path: destination.path,
      });
    } else {
      reasons.push({
        code: "destination_conflict_changed",
        path: destination.path,
      });
    }
  } else if (destination.hasConflict) {
    reasons.push({
      code: "destination_conflict_changed",
      path: destination.path,
    });
  }
}

function identityMatches(
  expected: FileIdentitySnapshot,
  actual: FileInspection,
): boolean {
  if (actual.size !== String(expected.sizeBytes)) {
    return false;
  }
  if (expected.mtimeNs !== null && actual.mtimeNs !== expected.mtimeNs) {
    return false;
  }
  if (expected.birthtimeNs !== null && actual.birthtimeNs !== expected.birthtimeNs) {
    return false;
  }
  if (expected.identityAvailable) {
    return actual.identityAvailable
      && expected.dev === actual.dev
      && expected.ino === actual.ino;
  }
  return true;
}

function toIdentitySnapshot(inspection: FileInspection): FileIdentitySnapshot {
  if (inspection.status !== "present" || inspection.size === null) {
    throw new Error("Cannot snapshot an unavailable file.");
  }
  const sizeBytes = Number(inspection.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("File size cannot be represented safely.");
  }
  return Object.freeze({
    volumeId: null,
    fileId: null,
    sizeBytes,
    mtimeNs: inspection.mtimeNs,
    birthtimeNs: inspection.birthtimeNs,
    attributes: null,
    reparseTag: null,
    partialHash: null,
    dev: inspection.dev,
    ino: inspection.ino,
    identityAvailable: inspection.identityAvailable,
  });
}

function isIdentitySnapshot(value: unknown): value is FileIdentitySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.sizeBytes)
    && typeof candidate.identityAvailable === "boolean"
    && isNullableString(candidate.mtimeNs)
    && isNullableString(candidate.birthtimeNs)
    && isNullableString(candidate.dev)
    && isNullableString(candidate.ino);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sameVolume(left: FileInspection, right: FileInspection): boolean {
  if (left.dev !== null && right.dev !== null) {
    return left.dev === right.dev;
  }
  return path.parse(left.path).root.toLocaleLowerCase("en-US")
    === path.parse(right.path).root.toLocaleLowerCase("en-US");
}

function sourceLocationReason(
  watchedRoot: string,
  sourcePath: string,
): PreflightBlockReason | null {
  const relativePath = path.relative(
    normalizeWindowsPath(watchedRoot),
    normalizeWindowsPath(sourcePath),
  );
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return { code: "source_outside_managed_root", path: sourcePath };
  }
  if (path.dirname(relativePath) !== ".") {
    return { code: "source_not_first_level", path: sourcePath };
  }
  return null;
}

function operationMatchesFrozenItem(context: OperationContext): boolean {
  return sameWindowsPath(context.operation.sourcePath, context.item.sourcePath)
    && sameWindowsPath(context.operation.destinationPath, context.item.destinationPath)
    && context.operation.strategy === context.item.expectedStrategy;
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function normalizeWindowsPath(value: string): string {
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}

function nodeErrorCode(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

function absentInspection(
  absolutePath: string,
  status: "missing" | "failed",
  errorCode: string,
): FileInspection {
  return Object.freeze({
    path: absolutePath,
    status,
    exists: status === "missing" ? false : null,
    isRegularFile: false,
    isDirectory: false,
    isLinkOrReparsePoint: false,
    size: null,
    mtimeNs: null,
    birthtimeNs: null,
    dev: null,
    ino: null,
    identityAvailable: false,
    errorCode,
  });
}

function blocked(
  operationId: string,
  reasons: readonly PreflightBlockReason[],
): Extract<PreflightResult, { status: "blocked" }> {
  return Object.freeze({
    status: "blocked",
    operationId,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason }))),
  });
}

function resultForPreflightBlock(
  operationId: string,
  reasons: readonly PreflightBlockReason[],
): FileOperationResult {
  const code = reasons[0]?.code ?? "inspection_failed";
  if (code === "protection_blocked") return operationResult("blocked", operationId, code, "剪映时间线正在引用此文件，已阻止移动。");
  if (code === "risk_confirmation_missing") return operationResult("blocked", operationId, code, "剪映备份引用尚未确认或已变化，请返回重新确认。");
  if (reasons.some((reason) => reason.code === "destination_conflict_changed" || reason.code === "conflict_policy_not_executable")) {
    return operationResult("blocked", operationId, code, "目标位置已有同名文件，未执行整理。");
  }
  if (reasons.some((reason) => reason.code === "source_missing")) {
    return operationResult("blocked", operationId, code, "原文件已经不在原位置，请重新扫描后再试。");
  }
  if (reasons.some((reason) => reason.code === "source_identity_changed")) {
    return operationResult("blocked", operationId, code, "原文件在确认后发生了变化，请重新生成整理预览。");
  }
  return operationResult("blocked", operationId, code, "整理前检查未通过，文件未移动。");
}

function operationResult(
  status: FileOperationResult["status"],
  operationId: string,
  code: string | null,
  message: string,
): FileOperationResult {
  return Object.freeze({ status, operationId, code, message });
}
