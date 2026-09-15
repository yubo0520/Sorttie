// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase, openSorttieDatabase } from "./database.js";
import {
  freezeOrganizationPlan,
  type FrozenOrganizationPlan,
  type OrganizationPlanDraft,
  type PlanId,
} from "./organizationPlan.js";
import { OrganizationPlanStore } from "./organizationPlanStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("frozen organization plans", () => {
  it("creates distinct plan and item identities and freezes nested values", () => {
    const plan = freezeOrganizationPlan(exampleDraft());

    expect(plan.planId).toMatch(/^plan_/);
    expect(plan.items.map((item) => item.planItemId)).toEqual([
      expect.stringMatching(/^item_/),
      expect.stringMatching(/^item_/),
    ]);
    expect(new Set(plan.items.map((item) => item.planItemId)).size).toBe(2);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.items)).toBe(true);
    expect(Object.isFrozen(plan.items[0])).toBe(true);
    expect(Object.isFrozen(plan.items[0].protection.evidence)).toBe(true);
    expect(Object.isFrozen(plan.items[0].sourceIdentity)).toBe(true);

    expect(() => {
      (plan.items[0] as unknown as { category: string }).category = "其他";
    }).toThrow(TypeError);
  });

  it("round-trips every reviewed field and preserves item order", () => {
    const { database, filename, store } = createTemporaryStore();
    const plan = store.createFrozenPlan(exampleDraft());
    database.close();

    const reopenedDatabase = openSorttieDatabase(filename);
    const reloaded = new OrganizationPlanStore(reopenedDatabase).loadFrozenPlan(plan.planId);

    expect(reloaded).toEqual(plan);
    expect(reloaded?.items.map((item) => item.registeredFileId)).toEqual([
      "file-image",
      "file-video",
    ]);
    expect(reloaded?.items[0]).toMatchObject({
      sourcePath: "D:\\downloads\\photo.png",
      destinationPath: "D:\\文件中心\\图片\\photo.png",
      conflictPolicy: "user_renamed",
      riskAccepted: true,
      protection: {
        level: "weak_warning",
        summary: "存在一条需要用户确认的弱证据。",
      },
    });
    reopenedDatabase.close();
  });

  it("does not change persisted data when migrations run repeatedly", () => {
    const { database, store } = createTemporaryStore();
    const plan = store.createFrozenPlan(exampleDraft());

    migrateDatabase(database);
    migrateDatabase(database);

    expect(store.loadFrozenPlan(plan.planId)).toEqual(plan);
    database.close();
  });

  it.each([
    "category = '其他'",
    "destination_path = 'D:\\文件中心\\其他\\photo.png'",
    "conflict_policy = 'skip'",
    "risk_accepted = 0",
    "expected_strategy = 'copy_verify_delete'",
    "protection_level = 'strong_block'",
    "protection_evidence_json = '[]'",
  ])("rejects direct mutation of a frozen plan item: %s", (assignment) => {
    const { database, store } = createTemporaryStore();
    const plan = store.createFrozenPlan(exampleDraft());

    expect(() => database.exec(`
      UPDATE organization_plan_items SET ${assignment}
      WHERE plan_item_id = '${plan.items[0].planItemId}'
    `)).toThrow(/frozen plan items are immutable/i);
    expect(store.loadFrozenPlan(plan.planId)).toEqual(plan);
    database.close();
  });

  it("rolls back every row when persistence fails after item insertion", () => {
    const { database, store } = createTemporaryStore();
    const plan = freezeOrganizationPlan(exampleDraft());
    database.exec(`
      CREATE TRIGGER inject_plan_insert_failure
      BEFORE INSERT ON organization_plans
      BEGIN
        SELECT RAISE(ABORT, 'injected plan failure');
      END
    `);

    expect(() => store.saveFrozenPlan(plan)).toThrow(/injected plan failure/i);
    expect(rowCount(database, "organization_plans")).toBe(0);
    expect(rowCount(database, "organization_plan_items")).toBe(0);
    database.close();
  });

  it("leaves the database empty when draft validation fails before persistence", () => {
    const { database, store } = createTemporaryStore();
    const draft = exampleDraft();
    const invalidDraft = {
      ...draft,
      items: [draft.items[0], { ...draft.items[1], destinationPath: draft.items[0].destinationPath }],
    } satisfies OrganizationPlanDraft;

    expect(() => store.createFrozenPlan(invalidDraft)).toThrow(/Duplicate destination path/i);
    expect(rowCount(database, "organization_plans")).toBe(0);
    expect(rowCount(database, "organization_plan_items")).toBe(0);
    database.close();
  });
});

describe("prepared operation identity", () => {
  it("persists one operationId for the same plan item across process reloads", () => {
    const directory = createTemporaryDirectory();
    const filename = join(directory, "sorttie.sqlite");
    const firstDatabase = openSorttieDatabase(filename);
    const firstStore = new OrganizationPlanStore(firstDatabase);
    const plan = firstStore.createFrozenPlan(exampleDraft());
    const first = firstStore.ensurePreparedOperation(plan.items[0].planItemId);

    expect(first.operationId).toMatch(/^op_/);
    expect(first.planId).toBe(plan.planId);
    expect(first.planItemId).toBe(plan.items[0].planItemId);
    firstDatabase.close();

    const secondDatabase = openSorttieDatabase(filename);
    const secondStore = new OrganizationPlanStore(secondDatabase);
    const reloadedById = secondStore.loadPreparedOperation(first.operationId);
    const ensuredAgain = secondStore.ensurePreparedOperation(plan.items[0].planItemId);

    expect(reloadedById).toEqual(first);
    expect(ensuredAgain).toEqual(first);
    expect(rowCount(secondDatabase, "operations")).toBe(1);
    expect(rowCount(secondDatabase, "operation_events")).toBe(1);
    secondDatabase.close();
  });

  it("rolls back the operation and initial event as one transaction", () => {
    const { database, store } = createTemporaryStore();
    const plan = store.createFrozenPlan(exampleDraft());
    database.exec(`
      CREATE TRIGGER inject_event_insert_failure
      BEFORE INSERT ON operation_events
      BEGIN
        SELECT RAISE(ABORT, 'injected event failure');
      END
    `);

    expect(() => store.ensurePreparedOperation(plan.items[0].planItemId)).toThrow(
      /injected event failure/i,
    );
    expect(rowCount(database, "operations")).toBe(0);
    expect(rowCount(database, "operation_events")).toBe(0);
    database.close();
  });

  it("rejects an item ID that is not part of a frozen plan", () => {
    const { database, store } = createTemporaryStore();

    expect(() => store.ensurePreparedOperation("item_missing" as never)).toThrow(
      /Unknown frozen plan item/i,
    );
    expect(rowCount(database, "operations")).toBe(0);
    database.close();
  });
});

function exampleDraft(): OrganizationPlanDraft {
  return {
    watchedRoot: "D:\\downloads",
    watchedRootIdentity: "volume-D:file-downloads",
    items: [
      {
        registeredFileId: "file-image",
        sourcePath: "D:\\downloads\\photo.png",
        destinationPath: "D:\\文件中心\\图片\\photo.png",
        category: "图片",
        conflictPolicy: "user_renamed",
        riskAccepted: true,
        protection: {
          level: "weak_warning",
          summary: "存在一条需要用户确认的弱证据。",
          evidence: [{
            kind: "project-history",
            source: "剪映备份",
            detail: "仅在历史备份中发现路径。",
            observedAt: "2026-09-04T01:02:03.000Z",
          }],
        },
        expectedStrategy: "same_volume_rename",
        sourceIdentity: {
          volumeId: "volume-D",
          fileId: "file-id-100",
          sizeBytes: 2048,
          mtimeNs: "1788483723000000000",
          birthtimeNs: "1788480000000000000",
          attributes: 32,
          reparseTag: null,
          partialHash: "sha256:partial-photo",
          dev: "3531345631",
          ino: "6192449488840374",
          identityAvailable: true,
        },
      },
      {
        registeredFileId: "file-video",
        sourcePath: "D:\\downloads\\video.mp4",
        destinationPath: "E:\\素材库\\视频\\video.mp4",
        category: "视频",
        conflictPolicy: "skip",
        riskAccepted: false,
        protection: {
          level: "none",
          summary: "未发现项目引用证据。",
          evidence: [],
        },
        expectedStrategy: "copy_verify_delete",
        sourceIdentity: {
          volumeId: "volume-D",
          fileId: "file-id-101",
          sizeBytes: 90_100_000,
          mtimeNs: "1788483700000000000",
          birthtimeNs: null,
          attributes: 32,
          reparseTag: null,
          partialHash: null,
          dev: null,
          ino: null,
          identityAvailable: false,
        },
      },
    ],
  };
}

function createTemporaryStore(): {
  database: DatabaseSync;
  filename: string;
  store: OrganizationPlanStore;
} {
  const directory = createTemporaryDirectory();
  const filename = join(directory, "sorttie.sqlite");
  const database = openSorttieDatabase(filename);
  return { database, filename, store: new OrganizationPlanStore(database) };
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sorttie-plan-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function rowCount(database: DatabaseSync, table: string): number {
  const allowedTables = new Set([
    "organization_plans",
    "organization_plan_items",
    "operations",
    "operation_events",
  ]);
  if (!allowedTables.has(table)) {
    throw new Error(`Unexpected test table: ${table}`);
  }
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count);
}
