import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  assertFrozenPlanIntegrity,
  createOperationId,
  freezeOrganizationPlan,
  restoreFrozenOrganizationPlan,
  restorePersistedOperation,
  restorePreparedOperation,
  type ConflictPolicy,
  type FileCategory,
  type FrozenOrganizationPlan,
  type FrozenOrganizationPlanItem,
  type OperationId,
  type OperationPhase,
  type OperationStrategy,
  type OrganizationPlanState,
  type OrganizationPlanDraft,
  type PersistedOperation,
  type PlanId,
  type PlanItemId,
  type PreparedOperation,
  type ProtectionLevel,
} from "./organizationPlan.js";

type PlanRow = {
  plan_id: string;
  watched_root: string;
  watched_root_identity: string | null;
  plan_hash: string;
  created_at: string;
  frozen_at: string;
};

type PlanItemRow = {
  plan_item_id: string;
  registered_file_id: string;
  source_path: string;
  destination_path: string;
  category: string;
  conflict_policy: string;
  risk_accepted: number;
  expected_strategy: string;
  protection_level: string;
  protection_summary: string;
  protection_evidence_json: string;
  source_volume_id: string | null;
  source_file_id: string | null;
  source_size_bytes: number;
  source_mtime_ns: string | null;
  source_birthtime_ns: string | null;
  source_attributes: number | null;
  source_reparse_tag: number | null;
  source_partial_hash: string | null;
  source_dev: string | null;
  source_ino: string | null;
  source_identity_available: number;
};

export type OperationContext = Readonly<{
  operation: PersistedOperation;
  planState: OrganizationPlanState;
  watchedRoot: string;
  watchedRootIdentity: string | null;
  item: FrozenOrganizationPlanItem;
}>;

type OperationRow = {
  operation_id: string;
  plan_id: string;
  plan_item_id: string;
  operation_kind: string;
  strategy: string;
  phase: string;
  source_path: string;
  destination_path: string;
  created_at: string;
  updated_at: string;
};

export class OrganizationPlanStore {
  constructor(private readonly database: DatabaseSync) {}

  createFrozenPlan(draft: OrganizationPlanDraft): FrozenOrganizationPlan {
    const plan = freezeOrganizationPlan(draft);
    this.saveFrozenPlan(plan);
    return plan;
  }

  saveFrozenPlan(plan: FrozenOrganizationPlan): void {
    assertFrozenPlanIntegrity(plan);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertItem = this.database.prepare(`
        INSERT INTO organization_plan_items (
          plan_item_id, plan_id, ordinal, registered_file_id,
          source_path, destination_path, category, conflict_policy,
          risk_accepted, expected_strategy, protection_level,
          protection_summary, protection_evidence_json, source_volume_id,
          source_file_id, source_size_bytes, source_mtime_ns,
          source_birthtime_ns, source_attributes, source_reparse_tag,
          source_partial_hash, source_dev, source_ino,
          source_identity_available
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
      `);

      plan.items.forEach((item, ordinal) => {
        insertItem.run(...itemBindings(plan.planId, item, ordinal));
      });

      this.database.prepare(`
        INSERT INTO organization_plans (
          plan_id, watched_root, watched_root_identity, plan_hash,
          state, created_at, frozen_at
        ) VALUES (?, ?, ?, ?, 'frozen', ?, ?)
      `).run(
        plan.planId,
        plan.watchedRoot,
        plan.watchedRootIdentity,
        plan.planHash,
        plan.createdAt,
        plan.frozenAt,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  loadFrozenPlan(planId: PlanId): FrozenOrganizationPlan | null {
    const planRow = this.database.prepare(`
      SELECT plan_id, watched_root, watched_root_identity, plan_hash,
             created_at, frozen_at
      FROM organization_plans
      WHERE plan_id = ?
    `).get(planId) as PlanRow | undefined;

    if (!planRow) {
      return null;
    }

    const itemRows = this.database.prepare(`
      SELECT plan_item_id, registered_file_id, source_path, destination_path,
             category, conflict_policy, risk_accepted, expected_strategy,
             protection_level, protection_summary, protection_evidence_json,
             source_volume_id, source_file_id, source_size_bytes,
             source_mtime_ns, source_birthtime_ns, source_attributes,
             source_reparse_tag, source_partial_hash, source_dev, source_ino,
             source_identity_available
      FROM organization_plan_items
      WHERE plan_id = ?
      ORDER BY ordinal
    `).all(planId) as PlanItemRow[];

    return restoreFrozenOrganizationPlan({
      planId: planRow.plan_id as PlanId,
      watchedRoot: planRow.watched_root,
      watchedRootIdentity: planRow.watched_root_identity,
      planHash: planRow.plan_hash,
      createdAt: planRow.created_at,
      frozenAt: planRow.frozen_at,
      items: itemRows.map(planItemFromRow),
    });
  }

  ensurePreparedOperation(planItemId: PlanItemId): PreparedOperation {
    const existing = this.loadPreparedOperationForItem(planItemId);
    if (existing) {
      return existing;
    }

    const source = this.database.prepare(`
      SELECT item.plan_id, item.source_path, item.destination_path,
             item.expected_strategy
      FROM organization_plan_items AS item
      JOIN organization_plans AS plan ON plan.plan_id = item.plan_id
      WHERE item.plan_item_id = ? AND plan.state = 'frozen'
    `).get(planItemId) as {
      plan_id: string;
      source_path: string;
      destination_path: string;
      expected_strategy: string;
    } | undefined;

    if (!source) {
      throw new Error(`Unknown frozen plan item: ${planItemId}`);
    }

    const timestamp = new Date().toISOString();
    const operation = restorePreparedOperation({
      operationId: createOperationId(),
      planId: source.plan_id as PlanId,
      planItemId,
      kind: "organize",
      strategy: source.expected_strategy as OperationStrategy,
      phase: "prepared",
      sourcePath: source.source_path,
      destinationPath: source.destination_path,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operationDuringTransaction = this.loadPreparedOperationForItem(planItemId);
      if (operationDuringTransaction) {
        this.database.exec("COMMIT");
        return operationDuringTransaction;
      }

      this.database.prepare(`
        INSERT INTO operations (
          operation_id, plan_id, plan_item_id, operation_kind, strategy,
          phase, source_path, destination_path, created_at, updated_at
        ) VALUES (?, ?, ?, 'organize', ?, 'prepared', ?, ?, ?, ?)
      `).run(
        operation.operationId,
        operation.planId,
        operation.planItemId,
        operation.strategy,
        operation.sourcePath,
        operation.destinationPath,
        operation.createdAt,
        operation.updatedAt,
      );
      this.database.prepare(`
        INSERT INTO operation_events (
          operation_id, phase, recorded_at, details_json
        ) VALUES (?, 'prepared', ?, '{}')
      `).run(operation.operationId, operation.createdAt);
      this.database.exec("COMMIT");
      return operation;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  loadPreparedOperation(operationId: OperationId): PreparedOperation | null {
    const operation = this.loadOperation(operationId);
    return operation?.phase === "prepared" ? operation as PreparedOperation : null;
  }

  loadOperation(operationId: OperationId): PersistedOperation | null {
    const row = this.database.prepare(`
      SELECT operation_id, plan_id, plan_item_id, operation_kind, strategy,
             phase, source_path, destination_path, created_at, updated_at
      FROM operations
      WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined;
    return row ? operationFromRow(row) : null;
  }

  loadOperationContext(operationId: OperationId): OperationContext | null {
    const operation = this.loadOperation(operationId);
    if (!operation) {
      return null;
    }

    const row = this.database.prepare(`
      SELECT plan.state, plan.watched_root, plan.watched_root_identity,
             item.plan_item_id, item.registered_file_id, item.source_path,
             item.destination_path, item.category, item.conflict_policy,
             item.risk_accepted, item.expected_strategy,
             item.protection_level, item.protection_summary,
             item.protection_evidence_json, item.source_volume_id,
             item.source_file_id, item.source_size_bytes, item.source_mtime_ns,
             item.source_birthtime_ns, item.source_attributes,
             item.source_reparse_tag, item.source_partial_hash,
             item.source_dev, item.source_ino, item.source_identity_available
      FROM organization_plans AS plan
      JOIN organization_plan_items AS item ON item.plan_id = plan.plan_id
      WHERE plan.plan_id = ? AND item.plan_item_id = ?
    `).get(operation.planId, operation.planItemId) as (PlanItemRow & {
      state: string;
      watched_root: string;
      watched_root_identity: string | null;
    }) | undefined;

    if (!row) {
      return null;
    }

    return Object.freeze({
      operation,
      planState: row.state as OrganizationPlanState,
      watchedRoot: row.watched_root,
      watchedRootIdentity: row.watched_root_identity,
      item: Object.freeze(planItemFromRow(row)),
    });
  }

  private loadPreparedOperationForItem(planItemId: PlanItemId): PreparedOperation | null {
    const row = this.database.prepare(`
      SELECT operation_id, plan_id, plan_item_id, operation_kind, strategy,
             phase, source_path, destination_path, created_at, updated_at
      FROM operations
      WHERE plan_item_id = ? AND operation_kind = 'organize'
    `).get(planItemId) as OperationRow | undefined;
    if (!row) {
      return null;
    }
    const operation = operationFromRow(row);
    return operation.phase === "prepared" ? operation as PreparedOperation : null;
  }
}

function itemBindings(
  planId: PlanId,
  item: FrozenOrganizationPlanItem,
  ordinal: number,
): SQLInputValue[] {
  return [
    item.planItemId,
    planId,
    ordinal,
    item.registeredFileId,
    item.sourcePath,
    item.destinationPath,
    item.category,
    item.conflictPolicy,
    item.riskAccepted ? 1 : 0,
    item.expectedStrategy,
    item.protection.level,
    item.protection.summary,
    JSON.stringify(item.protection.evidence),
    item.sourceIdentity.volumeId,
    item.sourceIdentity.fileId,
    item.sourceIdentity.sizeBytes,
    item.sourceIdentity.mtimeNs,
    item.sourceIdentity.birthtimeNs,
    item.sourceIdentity.attributes,
    item.sourceIdentity.reparseTag,
    item.sourceIdentity.partialHash,
    item.sourceIdentity.dev,
    item.sourceIdentity.ino,
    item.sourceIdentity.identityAvailable ? 1 : 0,
  ];
}

function planItemFromRow(row: PlanItemRow): FrozenOrganizationPlanItem {
  return {
    planItemId: row.plan_item_id as PlanItemId,
    registeredFileId: row.registered_file_id,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    category: row.category as FileCategory,
    conflictPolicy: row.conflict_policy as ConflictPolicy,
    riskAccepted: row.risk_accepted === 1,
    protection: {
      level: row.protection_level as ProtectionLevel,
      summary: row.protection_summary,
      evidence: JSON.parse(row.protection_evidence_json) as readonly {
        kind: string;
        source: string;
        detail: string;
        observedAt: string;
      }[],
    },
    expectedStrategy: row.expected_strategy as OperationStrategy,
    sourceIdentity: {
      volumeId: row.source_volume_id,
      fileId: row.source_file_id,
      sizeBytes: row.source_size_bytes,
      mtimeNs: row.source_mtime_ns,
      birthtimeNs: row.source_birthtime_ns,
      attributes: row.source_attributes,
      reparseTag: row.source_reparse_tag,
      partialHash: row.source_partial_hash,
      dev: row.source_dev,
      ino: row.source_ino,
      identityAvailable: row.source_identity_available === 1,
    },
  };
}

function operationFromRow(row: OperationRow): PersistedOperation {
  return restorePersistedOperation({
    operationId: row.operation_id as OperationId,
    planId: row.plan_id as PlanId,
    planItemId: row.plan_item_id as PlanItemId,
    kind: row.operation_kind as "organize",
    strategy: row.strategy as OperationStrategy,
    phase: row.phase as OperationPhase,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
