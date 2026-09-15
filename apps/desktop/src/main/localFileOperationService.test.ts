// @vitest-environment node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openSorttieDatabase } from "./database.js";
import {
  LocalFileOperationService,
  type PreflightResult,
} from "./localFileOperationService.js";
import type {
  ConflictPolicy,
  FileIdentitySnapshot,
  FrozenOrganizationPlan,
  PreparedOperation,
} from "./organizationPlan.js";
import { OrganizationPlanStore } from "./organizationPlanStore.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A restart test may already have closed this handle.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalFileOperationService inspect and preflight", () => {
  it("rechecks project references before the filesystem side effect", async () => {
    const fixture = createFixture();
    let calls = 0;
    const service = new LocalFileOperationService(new OrganizationPlanStore(fixture.database), fixture.database, undefined, async () => ({
      level: ++calls === 1 ? "none" : "strong_block", summary: "test", evidence: [],
    }));
    const result = await service.execute(fixture.operation.operationId);
    expect(result).toMatchObject({ status: "blocked", code: "protection_blocked" });
    expect(existsSync(fixture.sourcePath)).toBe(true); expect(existsSync(fixture.destinationPath)).toBe(false);
  });
  it("blocks new backup evidence or a failed protection check without moving", async () => {
    const fixture = createFixture();
    const store = new OrganizationPlanStore(fixture.database);
    const weak = new LocalFileOperationService(store, fixture.database, undefined, async () => ({ level: "weak_warning", summary: "backup", evidence: [] }));
    expect(reasonCodes(await weak.preflight(fixture.operation.operationId))).toContain("risk_confirmation_missing");
    const failed = new LocalFileOperationService(store, fixture.database, undefined, async () => { throw new Error("unavailable"); });
    expect(reasonCodes(await failed.preflight(fixture.operation.operationId))).toContain("inspection_failed");
    expect(readFileSync(fixture.sourcePath)).toEqual(fixture.sourceBytes);
  });
  it("returns ready for an unchanged first-level regular file", async () => {
    const fixture = createFixture();

    const inspection = await fixture.service.inspect(fixture.operation.operationId);
    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(inspection.status).toBe("inspected");
    if (inspection.status === "inspected") {
      expect(inspection.source).toMatchObject({
        exists: true,
        isRegularFile: true,
        isDirectory: false,
        isLinkOrReparsePoint: false,
        size: String(fixture.sourceBytes.length),
        identityAvailable: true,
      });
      expect(inspection.destination).toMatchObject({
        hasConflict: false,
        parent: { exists: true, isDirectory: true },
        target: { exists: false, status: "missing" },
      });
    }
    expect(result.status).toBe("ready");
  });

  it("returns a stable reason for an unknown operationId", async () => {
    const fixture = createFixture();

    const result = await fixture.service.preflight("op_missing" as never);

    expect(reasonCodes(result)).toEqual(["operation_not_found"]);
  });

  it("turns operation-context read failures into a structured result", async () => {
    const fixture = createFixture();
    fixture.database.close();

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["inspection_failed"]);
  });

  it("blocks an operation that is no longer prepared", async () => {
    const fixture = createFixture();
    fixture.database.prepare(
      "UPDATE operations SET phase = 'moving' WHERE operation_id = ?",
    ).run(fixture.operation.operationId);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toContain("operation_not_prepared");
  });

  it("blocks an operation whose plan is no longer frozen", async () => {
    const fixture = createFixture();
    fixture.database.prepare(
      "UPDATE organization_plans SET state = 'stale' WHERE plan_id = ?",
    ).run(fixture.plan.planId);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toContain("plan_not_frozen");
  });

  it("reports a source that disappeared after the plan was frozen", async () => {
    const fixture = createFixture();
    unlinkSync(fixture.sourcePath);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["source_missing"]);
  });

  it("rejects a source path that became a directory", async () => {
    const fixture = createFixture();
    unlinkSync(fixture.sourcePath);
    mkdirSync(fixture.sourcePath);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["source_not_regular_file"]);
  });

  it("rejects a junction or symbolic-link source without following it", async () => {
    const fixture = createFixture({ sourceKind: "junction" });

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["source_is_link"]);
  });

  it("detects a source size change", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.sourcePath, "changed and longer", "utf8");

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["source_identity_changed"]);
  });

  it("detects an mtime change when the size stays the same", async () => {
    const fixture = createFixture();
    const changedTime = new Date("2031-01-02T03:04:05.000Z");
    utimesSync(fixture.sourcePath, changedTime, changedTime);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(lstatSync(fixture.sourcePath, { bigint: true }).size.toString()).toBe(
      String(fixture.sourceBytes.length),
    );
    expect(reasonCodes(result)).toEqual(["source_identity_changed"]);
  });

  it("uses dev and ino to detect same-size, same-mtime replacement files", async () => {
    const fixedTime = new Date("2026-09-04T03:04:05.000Z");
    const fixture = createFixture({ fixedMtime: fixedTime, ignoreBirthtime: true });
    const replacementPath = join(fixture.baseDirectory, "replacement.txt");
    writeFileSync(replacementPath, fixture.sourceBytes);
    utimesSync(replacementPath, fixedTime, fixedTime);
    const original = lstatSync(fixture.sourcePath, { bigint: true });
    const replacement = lstatSync(replacementPath, { bigint: true });

    expect(original.dev).toBe(replacement.dev);
    expect(original.ino).not.toBe(replacement.ino);
    expect(original.size).toBe(replacement.size);
    expect(original.mtimeNs).toBe(replacement.mtimeNs);

    unlinkSync(fixture.sourcePath);
    renameSync(replacementPath, fixture.sourcePath);
    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["source_identity_changed"]);
  });

  it("detects a destination conflict that appeared after freezing", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.destinationPath, "new conflict", "utf8");

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["destination_conflict_changed"]);
  });

  it("blocks a skip policy rather than treating it as an executable move", async () => {
    const fixture = createFixture({
      conflictPolicy: "skip",
      destinationExistsAtFreeze: true,
    });

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toEqual(["conflict_policy_not_executable"]);
  });

  it("detects a destination parent that disappeared or became a file", async () => {
    const missingFixture = createFixture();
    rmSync(missingFixture.destinationParent, { recursive: true });

    expect(reasonCodes(
      await missingFixture.service.preflight(missingFixture.operation.operationId),
    )).toContain("destination_parent_missing");

    const fileFixture = createFixture();
    rmSync(fileFixture.destinationParent, { recursive: true });
    writeFileSync(fileFixture.destinationParent, "not a directory", "utf8");

    expect(reasonCodes(
      await fileFixture.service.preflight(fileFixture.operation.operationId),
    )).toContain("destination_parent_not_directory");
  });

  it.each([
    ["source_equals_destination", "same"],
    ["source_outside_managed_root", "outside"],
    ["source_not_first_level", "nested"],
  ] as const)("rejects an invalid frozen path with %s", async (expectedReason, kind) => {
    const fixture = createFixture();
    let sourcePath = fixture.sourcePath;
    let destinationPath = fixture.destinationPath;

    if (kind === "same") {
      destinationPath = sourcePath;
    } else if (kind === "outside") {
      sourcePath = join(fixture.baseDirectory, "outside.txt");
    } else {
      sourcePath = join(fixture.watchedRoot, "nested", "nested.txt");
    }
    tamperFrozenPaths(fixture, sourcePath, destinationPath);

    const result = await fixture.service.preflight(fixture.operation.operationId);

    expect(reasonCodes(result)).toContain(expectedReason);
  });

  it("returns the same result after the database and operation are reloaded", async () => {
    const fixture = createFixture();
    const beforeRestart = await fixture.service.preflight(fixture.operation.operationId);
    fixture.database.close();

    const reopenedDatabase = openSorttieDatabase(fixture.databasePath);
    databases.push(reopenedDatabase);
    const reopenedService = new LocalFileOperationService(
      new OrganizationPlanStore(reopenedDatabase),
      reopenedDatabase,
    );
    const afterRestart = await reopenedService.preflight(fixture.operation.operationId);

    expect(afterRestart).toEqual(beforeRestart);
  });

  it("does not change the database, source file, or destination directory", async () => {
    const fixture = createFixture();
    const databaseBefore = databaseSnapshot(fixture.database);
    const sourceBefore = statSnapshot(fixture.sourcePath);
    const destinationBefore = readdirSync(fixture.destinationParent).sort();

    expect((await fixture.service.preflight(fixture.operation.operationId)).status).toBe(
      "ready",
    );

    expect(databaseSnapshot(fixture.database)).toEqual(databaseBefore);
    expect(statSnapshot(fixture.sourcePath)).toEqual(sourceBefore);
    expect(readdirSync(fixture.destinationParent).sort()).toEqual(destinationBefore);
  });
});

describe("LocalFileOperationService single-file move and undo", () => {
  it("moves one frozen-plan file, records the receipt, and safely undoes it", async () => {
    const fixture = createFixture();

    const moved = await fixture.service.execute(fixture.operation.operationId);

    expect(moved).toMatchObject({ status: "moved", code: null });
    expect(existsSync(fixture.sourcePath)).toBe(false);
    expect(readFileSync(fixture.destinationPath)).toEqual(fixture.sourceBytes);
    expect(operationPhase(fixture)).toBe("completed");
    expect(eventPhases(fixture)).toEqual(["prepared", "moving", "completed"]);
    const receipt = lastEventDetails(fixture, "completed");
    expect(receipt).toMatchObject({
      kind: "same_volume_move_receipt",
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
    });

    const undone = await fixture.service.undo(fixture.operation.operationId);

    expect(undone).toMatchObject({ status: "undone", code: null });
    expect(readFileSync(fixture.sourcePath)).toEqual(fixture.sourceBytes);
    expect(existsSync(fixture.destinationPath)).toBe(false);
    expect(eventPhases(fixture)).toEqual([
      "prepared",
      "moving",
      "completed",
      "undo_moving",
      "undone",
    ]);
    expect(await fixture.service.undo(fixture.operation.operationId)).toMatchObject({
      status: "blocked",
      code: "undo_not_available",
    });
  });

  it("keeps source and operation prepared when preflight is blocked by a conflict", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.destinationPath, "conflict", "utf8");

    const result = await fixture.service.execute(fixture.operation.operationId);

    expect(result).toMatchObject({
      status: "blocked",
      code: "destination_conflict_changed",
      message: "目标位置已有同名文件，未执行整理。",
    });
    expect(readFileSync(fixture.sourcePath)).toEqual(fixture.sourceBytes);
    expect(readFileSync(fixture.destinationPath, "utf8")).toBe("conflict");
    expect(operationPhase(fixture)).toBe("prepared");
    expect(eventPhases(fixture)).toEqual(["prepared"]);
  });

  it("rejects the frozen cross-volume strategy without falling back to copy and delete", async () => {
    const fixture = createFixture({ expectedStrategy: "copy_verify_delete" });

    const result = await fixture.service.execute(fixture.operation.operationId);

    expect(result).toEqual({
      status: "blocked",
      operationId: fixture.operation.operationId,
      code: "cross_volume_unsupported",
      message: "当前版本暂不支持跨盘整理",
    });
    expect(readFileSync(fixture.sourcePath)).toEqual(fixture.sourceBytes);
    expect(existsSync(fixture.destinationPath)).toBe(false);
    expect(eventPhases(fixture)).toEqual(["prepared"]);
  });

  it("returns a preflight block without recording a move start", async () => {
    const fixture = createFixture();
    unlinkSync(fixture.sourcePath);

    const result = await fixture.service.execute(fixture.operation.operationId);

    expect(result).toMatchObject({ status: "blocked", code: "source_missing" });
    expect(existsSync(fixture.destinationPath)).toBe(false);
    expect(eventPhases(fixture)).toEqual(["prepared"]);
  });

  it("records a failed move while keeping the original file intact", async () => {
    const fixture = createFixture({
      renameFile: async () => {
        throw Object.assign(new Error("injected move failure"), { code: "EACCES" });
      },
    });

    const result = await fixture.service.execute(fixture.operation.operationId);

    expect(result).toMatchObject({ status: "failed", code: "move_failed" });
    expect(readFileSync(fixture.sourcePath)).toEqual(fixture.sourceBytes);
    expect(existsSync(fixture.destinationPath)).toBe(false);
    expect(operationPhase(fixture)).toBe("failed");
    expect(eventPhases(fixture)).toEqual(["prepared", "moving", "failed"]);
    expect(lastEventDetails(fixture, "failed")).toMatchObject({ code: "EACCES", stage: "rename" });
  });

  it("blocks undo when the original path has been occupied", async () => {
    const fixture = createFixture();
    expect((await fixture.service.execute(fixture.operation.operationId)).status).toBe("moved");
    writeFileSync(fixture.sourcePath, "new occupant", "utf8");

    const result = await fixture.service.undo(fixture.operation.operationId);

    expect(result).toMatchObject({ status: "blocked", code: "undo_source_occupied" });
    expect(readFileSync(fixture.sourcePath, "utf8")).toBe("new occupant");
    expect(readFileSync(fixture.destinationPath)).toEqual(fixture.sourceBytes);
  });

  it.each(["missing", "changed"] as const)("blocks undo when the destination is %s", async (condition) => {
    const fixture = createFixture();
    expect((await fixture.service.execute(fixture.operation.operationId)).status).toBe("moved");
    if (condition === "missing") unlinkSync(fixture.destinationPath);
    else writeFileSync(fixture.destinationPath, "changed destination", "utf8");

    const result = await fixture.service.undo(fixture.operation.operationId);

    expect(result).toMatchObject({
      status: "blocked",
      code: condition === "missing" ? "undo_destination_missing" : "undo_destination_changed",
    });
    expect(existsSync(fixture.sourcePath)).toBe(false);
  });
});

describe("categorized destination directories", () => {
  it("creates independent category folders only on execution and removes new empty folders on undo", async () => {
    const f = categorizedFixture();
    const before = databaseSnapshot(f.database);
    for (const operation of f.operations) expect((await f.service.preflight(operation.operationId)).status).toBe("ready");
    expect(databaseSnapshot(f.database)).toEqual(before);
    for (const category of ["图片", "视频", "代码与数据"]) expect(existsSync(join(f.destinationParent, category))).toBe(false);
    for (const operation of f.operations) expect((await f.service.execute(operation.operationId)).status).toBe("moved");
    for (const item of f.categoryPlan.items) {
      expect(existsSync(item.sourcePath)).toBe(false);
      expect(readFileSync(item.destinationPath, "utf8")).toBe("fixture");
    }
    for (const operation of [...f.operations].reverse()) expect((await f.service.undo(operation.operationId)).status).toBe("undone");
    for (const item of f.categoryPlan.items) expect(readFileSync(item.sourcePath, "utf8")).toBe("fixture");
    expect(readdirSync(f.destinationParent)).toEqual([]);
  });

  it("keeps original directories and newly created directories that now contain another file", async () => {
    const f = categorizedFixture(true);
    for (const operation of f.operations) expect((await f.service.execute(operation.operationId)).status).toBe("moved");
    const added = join(f.destinationParent, "视频", "later.txt");
    writeFileSync(added, "user addition");
    for (const operation of [...f.operations].reverse()) expect((await f.service.undo(operation.operationId)).status).toBe("undone");
    expect(existsSync(join(f.destinationParent, "图片"))).toBe(true);
    expect(readFileSync(added, "utf8")).toBe("user addition");
    expect(existsSync(join(f.destinationParent, "代码与数据"))).toBe(false);
  });

  it("keeps a shared category folder until its last file has been undone, including after service reload", async () => {
    const f = categorizedFixture();
    for (const operation of f.operations) await f.service.execute(operation.operationId);
    const store = new OrganizationPlanStore(f.database);
    const reloaded = new LocalFileOperationService(store, f.database);
    await reloaded.undo(f.operations[3].operationId);
    expect(existsSync(join(f.destinationParent, "图片"))).toBe(true);
    await reloaded.undo(f.operations[0].operationId);
    expect(existsSync(join(f.destinationParent, "图片"))).toBe(false);
  });

  it.each(["file", "junction", "root-missing", "existing-removed"] as const)("blocks changed directory state: %s", async (change) => {
    const f = categorizedFixture(change === "existing-removed");
    const category = join(f.destinationParent, "图片");
    if (change === "file") writeFileSync(category, "not a folder");
    if (change === "junction") symlinkSync(f.watchedRoot, category, "junction");
    if (change === "root-missing") rmSync(f.destinationParent, { recursive: true });
    if (change === "existing-removed") rmSync(category, { recursive: true });
    const result = await f.service.execute(f.operations[0].operationId);
    expect(result.status).toBe("blocked");
    expect(readFileSync(f.categoryPlan.items[0].sourcePath, "utf8")).toBe("fixture");
  });

  it("does not create any folder when source preflight or cross-volume validation fails", async () => {
    const f = categorizedFixture();
    writeFileSync(f.categoryPlan.items[0].sourcePath, "changed");
    expect((await f.service.execute(f.operations[0].operationId)).status).toBe("blocked");
    expect(existsSync(join(f.destinationParent, "图片"))).toBe(false);
    f.database.exec("DROP TRIGGER operation_intent_is_immutable");
    f.database.prepare("UPDATE operations SET strategy = 'copy_verify_delete' WHERE operation_id = ?").run(f.operations[1].operationId);
    expect((await f.service.execute(f.operations[1].operationId)).status).toBe("blocked");
    expect(existsSync(join(f.destinationParent, "视频"))).toBe(false);
  });

  it("retains a newly created folder when its identity was replaced", async () => {
    const f = categorizedFixture();
    await f.service.execute(f.operations[1].operationId);
    const folder = join(f.destinationParent, "视频");
    const saved = join(f.destinationParent, "original-video-folder");
    renameSync(folder, saved);
    mkdirSync(folder);
    renameSync(join(saved, "b.mp4"), join(folder, "b.mp4"));
    expect((await f.service.undo(f.operations[1].operationId)).status).toBe("undone");
    expect(existsSync(folder)).toBe(true);
  });

  it("does not claim a directory created externally after freezing and blocks new target conflicts", async () => {
    const f = categorizedFixture();
    const folder = join(f.destinationParent, "视频");
    mkdirSync(folder);
    const target = f.categoryPlan.items[1].destinationPath;
    writeFileSync(target, "existing target");
    expect(await f.service.execute(f.operations[1].operationId)).toMatchObject({ status: "blocked", code: "destination_conflict_changed" });
    expect(readFileSync(target, "utf8")).toBe("existing target");
    unlinkSync(target);
    expect((await f.service.execute(f.operations[1].operationId)).status).toBe("moved");
    expect((await f.service.undo(f.operations[1].operationId)).status).toBe("undone");
    expect(existsSync(folder)).toBe(true);
  });

  it("does not move a file when creation ownership cannot be persisted", async () => {
    const f = categorizedFixture();
    f.database.exec(`CREATE TRIGGER fail_directory_receipt BEFORE INSERT ON operation_events
      WHEN NEW.phase = 'directory_created' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect(await f.service.execute(f.operations[0].operationId)).toMatchObject({ status: "failed", code: "directory_creation_failed" });
    expect(readFileSync(f.categoryPlan.items[0].sourcePath, "utf8")).toBe("fixture");
    expect(existsSync(f.categoryPlan.items[0].destinationPath)).toBe(false);
  });
});

function categorizedFixture(existingImageDirectory = false) {
  const f = createFixture();
  if (existingImageDirectory) mkdirSync(join(f.destinationParent, "图片"));
  const store = new OrganizationPlanStore(f.database);
  const pairs = [["a.png", "图片"], ["b.mp4", "视频"], ["debug.log", "代码与数据"], ["second.png", "图片"]] as const;
  const categoryPlan = store.createFrozenPlan({
    watchedRoot: f.watchedRoot, watchedRootIdentity: null,
    items: pairs.map(([name, category]) => {
      const sourcePath = join(f.watchedRoot, name);
      writeFileSync(sourcePath, "fixture");
      return { ...f.plan.items[0], registeredFileId: name, sourcePath, category,
        destinationPath: join(f.destinationParent, category, name), sourceIdentity: identitySnapshot(sourcePath, false) };
    }),
  });
  const rootStats = lstatSync(f.destinationParent, { bigint: true });
  const operations = categoryPlan.items.map((item) => {
    const operation = store.ensurePreparedOperation(item.planItemId);
    f.database.prepare("INSERT INTO operation_events (operation_id, phase, recorded_at, details_json) VALUES (?, 'directory_planned', ?, ?)").run(operation.operationId, new Date().toISOString(), JSON.stringify({
      rootPath: f.destinationParent, rootDev: rootStats.dev.toString(), rootIno: rootStats.ino.toString(), rootBirthtimeNs: rootStats.birthtimeNs.toString(),
      directoryPath: join(f.destinationParent, item.category), existed: existingImageDirectory && item.category === "图片",
    }));
    return operation;
  });
  return { ...f, operations, categoryPlan };
}

type FixtureOptions = {
  conflictPolicy?: ConflictPolicy;
  destinationExistsAtFreeze?: boolean;
  fixedMtime?: Date;
  ignoreBirthtime?: boolean;
  sourceKind?: "file" | "junction";
  expectedStrategy?: "same_volume_rename" | "copy_verify_delete";
  renameFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
};

type Fixture = {
  baseDirectory: string;
  watchedRoot: string;
  destinationParent: string;
  sourcePath: string;
  destinationPath: string;
  sourceBytes: Buffer;
  databasePath: string;
  database: DatabaseSync;
  plan: FrozenOrganizationPlan;
  operation: PreparedOperation;
  service: LocalFileOperationService;
};

function createFixture(options: FixtureOptions = {}): Fixture {
  const baseDirectory = mkdtempSync(join(tmpdir(), "sorttie-preflight-"));
  temporaryDirectories.push(baseDirectory);
  const watchedRoot = join(baseDirectory, "Downloads");
  const destinationParent = join(baseDirectory, "Library");
  const sourcePath = join(watchedRoot, "source.txt");
  const destinationPath = join(destinationParent, "source.txt");
  const sourceBytes = Buffer.from("sorttie source", "utf8");
  mkdirSync(watchedRoot);
  mkdirSync(destinationParent);

  if (options.sourceKind === "junction") {
    const targetDirectory = join(baseDirectory, "junction-target");
    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, sourcePath, "junction");
  } else {
    writeFileSync(sourcePath, sourceBytes);
  }
  if (options.fixedMtime) {
    utimesSync(sourcePath, options.fixedMtime, options.fixedMtime);
  }
  if (options.destinationExistsAtFreeze) {
    writeFileSync(destinationPath, "existing target", "utf8");
  }

  const identity = identitySnapshot(sourcePath, options.ignoreBirthtime ?? false);
  const databasePath = join(baseDirectory, "sorttie.sqlite");
  const database = openSorttieDatabase(databasePath);
  databases.push(database);
  const store = new OrganizationPlanStore(database);
  const plan = store.createFrozenPlan({
    watchedRoot,
    watchedRootIdentity: `dev:${identity.dev ?? "unknown"}`,
    items: [{
      registeredFileId: "registered-source",
      sourcePath,
      destinationPath,
      category: "文档",
      conflictPolicy: options.conflictPolicy ?? "fail",
      riskAccepted: false,
      protection: {
        level: "none",
        summary: "No project reference evidence.",
        evidence: [],
      },
      expectedStrategy: options.expectedStrategy ?? "same_volume_rename",
      sourceIdentity: identity,
    }],
  });
  const operation = store.ensurePreparedOperation(plan.items[0].planItemId);

  return {
    baseDirectory,
    watchedRoot,
    destinationParent,
    sourcePath,
    destinationPath,
    sourceBytes,
    databasePath,
    database,
    plan,
    operation,
    service: new LocalFileOperationService(store, database, options.renameFile),
  };
}

function identitySnapshot(
  filePath: string,
  ignoreBirthtime: boolean,
): FileIdentitySnapshot {
  const stats = lstatSync(filePath, { bigint: true });
  const identityAvailable = stats.dev !== 0n && stats.ino !== 0n;
  return {
    volumeId: null,
    fileId: null,
    sizeBytes: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    birthtimeNs: ignoreBirthtime ? null : stats.birthtimeNs.toString(),
    attributes: null,
    reparseTag: null,
    partialHash: null,
    dev: identityAvailable ? stats.dev.toString() : null,
    ino: identityAvailable ? stats.ino.toString() : null,
    identityAvailable,
  };
}

function reasonCodes(result: PreflightResult): string[] {
  return result.status === "blocked"
    ? result.reasons.map((reason) => reason.code)
    : [];
}

function operationPhase(fixture: Fixture): string {
  const row = fixture.database.prepare(
    "SELECT phase FROM operations WHERE operation_id = ?",
  ).get(fixture.operation.operationId) as { phase: string };
  return row.phase;
}

function eventPhases(fixture: Fixture): string[] {
  return (fixture.database.prepare(`
    SELECT phase FROM operation_events
    WHERE operation_id = ? ORDER BY event_id
  `).all(fixture.operation.operationId) as { phase: string }[]).map((row) => row.phase);
}

function lastEventDetails(fixture: Fixture, phase: string): Record<string, unknown> {
  const row = fixture.database.prepare(`
    SELECT details_json FROM operation_events
    WHERE operation_id = ? AND phase = ?
    ORDER BY event_id DESC LIMIT 1
  `).get(fixture.operation.operationId, phase) as { details_json: string };
  return JSON.parse(row.details_json) as Record<string, unknown>;
}

function tamperFrozenPaths(
  fixture: Fixture,
  sourcePath: string,
  destinationPath: string,
): void {
  fixture.database.exec("DROP TRIGGER frozen_plan_item_cannot_be_updated");
  fixture.database.exec("DROP TRIGGER operation_intent_is_immutable");
  fixture.database.prepare(`
    UPDATE organization_plan_items
    SET source_path = ?, destination_path = ?
    WHERE plan_item_id = ?
  `).run(sourcePath, destinationPath, fixture.operation.planItemId);
  fixture.database.prepare(`
    UPDATE operations
    SET source_path = ?, destination_path = ?
    WHERE operation_id = ?
  `).run(sourcePath, destinationPath, fixture.operation.operationId);
}

function statSnapshot(filePath: string): Record<string, string | boolean> {
  const stats = lstatSync(filePath, { bigint: true });
  return {
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    isFile: stats.isFile(),
  };
}

function databaseSnapshot(database: DatabaseSync): unknown {
  return {
    changes: database.prepare("SELECT total_changes() AS value").get(),
    migrations: database.prepare(
      "SELECT * FROM schema_migrations ORDER BY version",
    ).all(),
    plans: database.prepare(
      "SELECT * FROM organization_plans ORDER BY plan_id",
    ).all(),
    items: database.prepare(
      "SELECT * FROM organization_plan_items ORDER BY plan_item_id",
    ).all(),
    operations: database.prepare(
      "SELECT * FROM operations ORDER BY operation_id",
    ).all(),
    events: database.prepare(
      "SELECT * FROM operation_events ORDER BY event_id",
    ).all(),
  };
}
