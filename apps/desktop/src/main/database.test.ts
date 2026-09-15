// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  migrateDatabase,
  openSorttieDatabase,
} from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite migrations", () => {
  it("preserves favorites across migration reruns and database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "sorttie-favorites-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "sorttie.sqlite");
    let database = openSorttieDatabase(file);
    database.prepare("INSERT INTO file_favorites VALUES (?, ?, ?, ?, ?)").run("a".repeat(64), directory, join(directory, "image.png"), "1:2:3", "2026-09-05");
    const before = database.prepare("SELECT * FROM file_favorites").all();
    migrateDatabase(database);
    database.close();
    database = openSorttieDatabase(file);
    expect(database.prepare("SELECT * FROM file_favorites").all()).toEqual(before);
    database.close();
  });
  it("creates the complete version-one schema in a new database", () => {
    const database = createTemporaryDatabase();

    expect(getSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(database)).toEqual([
      "file_favorites",
      "operation_events",
      "operations",
      "organization_plan_items",
      "organization_plans",
      "schema_migrations",
    ]);
    expect(triggerNames(database)).toEqual([
      "frozen_plan_cannot_be_deleted",
      "frozen_plan_fields_are_immutable",
      "frozen_plan_item_cannot_be_deleted",
      "frozen_plan_item_cannot_be_inserted",
      "frozen_plan_item_cannot_be_updated",
      "operation_intent_is_immutable",
    ]);

    database.close();
  });

  it("is idempotent and records each migration once", () => {
    const database = createTemporaryDatabase();

    migrateDatabase(database);
    migrateDatabase(database);

    const rows = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as { version: number }[];
    expect(rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    database.close();
  });

  it("enables foreign-key enforcement on every opened database", () => {
    const database = createTemporaryDatabase();
    const setting = database.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };

    expect(setting.foreign_keys).toBe(1);
    expect(() => database.prepare(`
      INSERT INTO operations (
        operation_id, plan_id, plan_item_id, operation_kind, strategy,
        phase, source_path, destination_path, created_at, updated_at
      ) VALUES (
        'op_missing', 'plan_missing', 'item_missing', 'organize',
        'same_volume_rename', 'prepared', 'C:\\source.txt',
        'D:\\destination.txt', '2026-09-04T00:00:00.000Z',
        '2026-09-04T00:00:00.000Z'
      )
    `).run()).toThrow(/FOREIGN KEY constraint failed/i);
    database.close();
  });
});

function createTemporaryDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "sorttie-sqlite-"));
  temporaryDirectories.push(directory);
  return openSorttieDatabase(join(directory, "sorttie.sqlite"));
}

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[]).map((row) => row.name);
}

function triggerNames(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name
  `).all() as { name: string }[]).map((row) => row.name);
}
