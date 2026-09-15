import { createHash, randomUUID } from "node:crypto";
import { win32 as path } from "node:path";

export type PlanId = string & { readonly __brand: "PlanId" };
export type PlanItemId = string & { readonly __brand: "PlanItemId" };
export type OperationId = string & { readonly __brand: "OperationId" };

export const FILE_CATEGORIES = [
  "图片",
  "视频",
  "音频",
  "文档",
  "代码与数据",
  "压缩包",
  "其他",
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];
export type ConflictPolicy = "fail" | "skip" | "user_renamed";
export type OperationStrategy = "same_volume_rename" | "copy_verify_delete";
export type ProtectionLevel = "none" | "weak_warning" | "strong_block";
export type OrganizationPlanState =
  | "frozen"
  | "executing"
  | "completed"
  | "stale"
  | "abandoned";
export type OperationPhase =
  | "prepared"
  | "moving"
  | "copying"
  | "destination_committed"
  | "source_removing"
  | "source_removed"
  | "completed"
  | "failed"
  | "manual_review";

export type ProtectionEvidence = Readonly<{
  kind: string;
  source: string;
  detail: string;
  observedAt: string;
}>;

export type ProtectionConclusion = Readonly<{
  level: ProtectionLevel;
  summary: string;
  evidence: readonly ProtectionEvidence[];
}>;

export type FileIdentitySnapshot = Readonly<{
  volumeId: string | null;
  fileId: string | null;
  sizeBytes: number;
  mtimeNs: string | null;
  birthtimeNs: string | null;
  attributes: number | null;
  reparseTag: number | null;
  partialHash: string | null;
  dev: string | null;
  ino: string | null;
  identityAvailable: boolean;
}>;

export type OrganizationPlanItemDraft = Readonly<{
  registeredFileId: string;
  sourcePath: string;
  destinationPath: string;
  category: FileCategory;
  conflictPolicy: ConflictPolicy;
  riskAccepted: boolean;
  protection: ProtectionConclusion;
  expectedStrategy: OperationStrategy;
  sourceIdentity: FileIdentitySnapshot;
}>;

export type OrganizationPlanDraft = Readonly<{
  watchedRoot: string;
  watchedRootIdentity: string | null;
  items: readonly OrganizationPlanItemDraft[];
}>;

export type FrozenOrganizationPlanItem = Readonly<OrganizationPlanItemDraft & {
  planItemId: PlanItemId;
}>;

export type FrozenOrganizationPlan = Readonly<{
  planId: PlanId;
  watchedRoot: string;
  watchedRootIdentity: string | null;
  createdAt: string;
  frozenAt: string;
  planHash: string;
  items: readonly FrozenOrganizationPlanItem[];
}>;

export type PersistedOperation = Readonly<{
  operationId: OperationId;
  planId: PlanId;
  planItemId: PlanItemId;
  kind: "organize";
  strategy: OperationStrategy;
  phase: OperationPhase;
  sourcePath: string;
  destinationPath: string;
  createdAt: string;
  updatedAt: string;
}>;

export type PreparedOperation = PersistedOperation & Readonly<{ phase: "prepared" }>;

const categorySet = new Set<string>(FILE_CATEGORIES);
const conflictPolicies = new Set<string>(["fail", "skip", "user_renamed"]);
const operationStrategies = new Set<string>([
  "same_volume_rename",
  "copy_verify_delete",
]);
const protectionLevels = new Set<string>([
  "none",
  "weak_warning",
  "strong_block",
]);
const operationPhases = new Set<string>([
  "prepared",
  "moving",
  "copying",
  "destination_committed",
  "source_removing",
  "source_removed",
  "completed",
  "failed",
  "manual_review",
]);

export function createPlanId(): PlanId {
  return `plan_${randomUUID()}` as PlanId;
}

export function createPlanItemId(): PlanItemId {
  return `item_${randomUUID()}` as PlanItemId;
}

export function createOperationId(): OperationId {
  return `op_${randomUUID()}` as OperationId;
}

export function freezeOrganizationPlan(
  draft: OrganizationPlanDraft,
  now = new Date().toISOString(),
): FrozenOrganizationPlan {
  validateDraft(draft);

  const items = draft.items.map((item) => freezePlanItem({
    planItemId: createPlanItemId(),
    registeredFileId: item.registeredFileId,
    sourcePath: item.sourcePath,
    destinationPath: item.destinationPath,
    category: item.category,
    conflictPolicy: item.conflictPolicy,
    riskAccepted: item.riskAccepted,
    protection: cloneProtection(item.protection),
    expectedStrategy: item.expectedStrategy,
    sourceIdentity: Object.freeze({ ...item.sourceIdentity }),
  }));

  const payload = {
    planId: createPlanId(),
    watchedRoot: draft.watchedRoot,
    watchedRootIdentity: draft.watchedRootIdentity,
    createdAt: now,
    frozenAt: now,
    items,
  };

  const plan = Object.freeze({
    ...payload,
    planHash: hashPlanPayload(payload),
    items: Object.freeze(items),
  });

  assertFrozenPlanIntegrity(plan);
  return plan;
}

export function assertFrozenPlanIntegrity(plan: FrozenOrganizationPlan): void {
  validateId(plan.planId, "plan_", "planId");
  validateTimestamp(plan.createdAt, "createdAt");
  validateTimestamp(plan.frozenAt, "frozenAt");
  validateDraft({
    watchedRoot: plan.watchedRoot,
    watchedRootIdentity: plan.watchedRootIdentity,
    items: plan.items,
  });

  const itemIds = new Set<string>();
  for (const item of plan.items) {
    validateId(item.planItemId, "item_", "planItemId");
    if (itemIds.has(item.planItemId)) {
      throw new Error(`Duplicate planItemId: ${item.planItemId}`);
    }
    itemIds.add(item.planItemId);
  }

  const expectedHash = hashPlanPayload({
    planId: plan.planId,
    watchedRoot: plan.watchedRoot,
    watchedRootIdentity: plan.watchedRootIdentity,
    createdAt: plan.createdAt,
    frozenAt: plan.frozenAt,
    items: plan.items,
  });
  if (plan.planHash !== expectedHash) {
    throw new Error("Frozen organization plan hash does not match its contents.");
  }
}

export function restoreFrozenOrganizationPlan(
  value: FrozenOrganizationPlan,
): FrozenOrganizationPlan {
  const items = value.items.map((item) => freezePlanItem({
    ...item,
    protection: cloneProtection(item.protection),
    sourceIdentity: Object.freeze({ ...item.sourceIdentity }),
  }));
  const plan = Object.freeze({ ...value, items: Object.freeze(items) });
  assertFrozenPlanIntegrity(plan);
  return plan;
}

export function restorePersistedOperation(value: PersistedOperation): PersistedOperation {
  validateId(value.operationId, "op_", "operationId");
  validateId(value.planId, "plan_", "planId");
  validateId(value.planItemId, "item_", "planItemId");
  validateTimestamp(value.createdAt, "createdAt");
  validateTimestamp(value.updatedAt, "updatedAt");
  if (value.kind !== "organize" || !operationPhases.has(value.phase)) {
    throw new Error("Unsupported operation kind or phase.");
  }
  if (!operationStrategies.has(value.strategy)) {
    throw new Error(`Unsupported operation strategy: ${value.strategy}`);
  }
  return Object.freeze({ ...value });
}

export function restorePreparedOperation(value: PreparedOperation): PreparedOperation {
  const operation = restorePersistedOperation(value);
  if (operation.phase !== "prepared") {
    throw new Error("Operation is not prepared.");
  }
  return operation as PreparedOperation;
}

function validateDraft(draft: OrganizationPlanDraft): void {
  if (!path.isAbsolute(draft.watchedRoot)) {
    throw new Error("watchedRoot must be an absolute Windows path.");
  }
  if (draft.items.length === 0) {
    throw new Error("An organization plan must contain at least one item.");
  }

  const normalizedRoot = normalizeWindowsPath(draft.watchedRoot);
  const sources = new Set<string>();
  const destinations = new Set<string>();

  for (const item of draft.items) {
    if (!item.registeredFileId.trim()) {
      throw new Error("registeredFileId must not be empty.");
    }
    if (!path.isAbsolute(item.sourcePath) || !path.isAbsolute(item.destinationPath)) {
      throw new Error("Plan source and destination paths must be absolute Windows paths.");
    }
    if (normalizeWindowsPath(path.dirname(item.sourcePath)) !== normalizedRoot) {
      throw new Error("Plan sources must be first-level files in the watched root.");
    }
    if (!categorySet.has(item.category)) {
      throw new Error(`Unsupported file category: ${item.category}`);
    }
    if (!conflictPolicies.has(item.conflictPolicy)) {
      throw new Error(`Unsupported conflict policy: ${item.conflictPolicy}`);
    }
    if (!operationStrategies.has(item.expectedStrategy)) {
      throw new Error(`Unsupported operation strategy: ${item.expectedStrategy}`);
    }
    if (!protectionLevels.has(item.protection.level)) {
      throw new Error(`Unsupported protection level: ${item.protection.level}`);
    }
    if (!Number.isSafeInteger(item.sourceIdentity.sizeBytes) || item.sourceIdentity.sizeBytes < 0) {
      throw new Error("Source size must be a non-negative safe integer.");
    }

    const source = normalizeWindowsPath(item.sourcePath);
    const destination = normalizeWindowsPath(item.destinationPath);
    if (source === destination) {
      throw new Error("Source and destination paths must differ.");
    }
    if (sources.has(source)) {
      throw new Error(`Duplicate source path: ${item.sourcePath}`);
    }
    if (destinations.has(destination)) {
      throw new Error(`Duplicate destination path: ${item.destinationPath}`);
    }
    sources.add(source);
    destinations.add(destination);
  }
}

function freezePlanItem(item: FrozenOrganizationPlanItem): FrozenOrganizationPlanItem {
  return Object.freeze(item);
}

function cloneProtection(value: ProtectionConclusion): ProtectionConclusion {
  return Object.freeze({
    level: value.level,
    summary: value.summary,
    evidence: Object.freeze(value.evidence.map((entry) => Object.freeze({ ...entry }))),
  });
}

function hashPlanPayload(payload: Omit<FrozenOrganizationPlan, "planHash">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function normalizeWindowsPath(value: string): string {
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}

function validateId(value: string, prefix: string, field: string): void {
  if (!value.startsWith(prefix) || value.length <= prefix.length) {
    throw new Error(`${field} has an invalid prefix.`);
  }
}

function validateTimestamp(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible timestamp.`);
  }
}
