// @vitest-environment node

import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileRecord } from "../shared/contracts";
import { classifyExtension, previewCapabilityFor, scanTopLevelFiles, stableFileId, WatchDirectoryManager } from "./fileMonitor";

const temporaryRoots: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `sorttie-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher state");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deterministic file classification", () => {
  it.each([
    [".PNG", "图片"], [".mp4", "视频"], [".WAV", "音频"], [".pdf", "文档"],
    [".LOG", "代码与数据"], [".zip", "压缩包"], [".unusual", "其他"],
  ])("classifies %s without reading file content", (extension, category) => {
    expect(classifyExtension(extension)).toBe(category);
  });

  it.each([
    [".png", "image", "image"], [".mp4", "video", "video"], [".wav", "audio", "audio"],
    [".pdf", "document", "pdf"], [".LOG", "code", "text"], [".docx", "document", "unsupported"],
  ])("maps %s to the %s preview capability", (extension, kind, capability) => {
    expect(previewCapabilityFor(extension, kind as Parameters<typeof previewCapabilityFor>[1])).toBe(capability);
  });
});

describe("top-level scanning", () => {
  it("returns regular first-level files and ignores directories and their contents", async () => {
    const root = await temporaryDirectory("scan");
    await writeFile(path.join(root, "普通 文件.txt"), "hello", "utf8");
    await writeFile(path.join(root, "数据 #1.unknown"), "unknown", "utf8");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "hidden.log"), "hidden", "utf8");

    const files = await scanTopLevelFiles(root);

    expect(files.map((file) => file.name)).toEqual(expect.arrayContaining(["普通 文件.txt", "数据 #1.unknown"]));
    expect(files.map((file) => file.name)).not.toContain("nested");
    expect(files.map((file) => file.name)).not.toContain("hidden.log");
    expect(files.find((file) => file.name.endsWith(".unknown"))?.category).toBe("其他");
    expect(files.every((file) => file.id === stableFileId(root, file.name))).toBe(true);
    expect(files.every((file) => file.lastActivityKind === "observed")).toBe(true);
  });

  it("marks incomplete downloads as unavailable without changing them", async () => {
    const root = await temporaryDirectory("download");
    const filePath = path.join(root, "素材.crdownload");
    await writeFile(filePath, "partial", "utf8");
    const before = await stat(filePath);

    const [file] = await scanTopLevelFiles(root);
    const after = await stat(filePath);

    expect(file.status).toBe("downloading");
    expect(file.isOrganizable).toBe(false);
    expect(file.unavailableReason).toBe("下载尚未完成");
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("watch-directory manager", () => {
  it("publishes debounced add, change, and delete snapshots", async () => {
    const userData = await temporaryDirectory("userdata");
    const root = await temporaryDirectory("watch");
    const manager = new WatchDirectoryManager(userData, 80);
    const events: string[] = [];
    manager.subscribe((event) => {
      if (event.snapshot.reason === "watch") events.push(event.notice ?? "no-change");
    });
    await manager.setDirectory(root);
    const target = path.join(root, "变化.log");

    await writeFile(target, "one", "utf8");
    await writeFile(target, "two", "utf8");
    await writeFile(target, "three", "utf8");
    await waitUntil(() => manager.getFiles().some((file) => file.name === "变化.log"));
    await new Promise((resolve) => setTimeout(resolve, 240));
    expect(events.filter((notice) => notice.includes("新增")).length).toBe(1);
    expect(manager.getFiles()[0]?.lastActivityKind).toBe("created");

    await writeFile(target, "changed-content", "utf8");
    await waitUntil(() => manager.getFiles()[0]?.sizeBytes === 15);
    expect(events.some((notice) => notice.includes("更新"))).toBe(true);
    expect(manager.getFiles()[0]?.lastActivityKind).toBe("modified");

    await rm(target);
    await waitUntil(() => manager.getFiles().length === 0);
    expect(events.some((notice) => notice.includes("移除"))).toBe(true);
    await manager.dispose();
  });

  it("closes the old watcher when switching directories", async () => {
    const userData = await temporaryDirectory("switch-userdata");
    const first = await temporaryDirectory("switch-first");
    const second = await temporaryDirectory("switch-second");
    const manager = new WatchDirectoryManager(userData, 60);
    await manager.setDirectory(first);
    await manager.setDirectory(second);

    await writeFile(path.join(first, "old.txt"), "old", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(manager.getFiles()).toHaveLength(0);

    await writeFile(path.join(second, "new.txt"), "new", "utf8");
    await waitUntil(() => manager.getFiles().some((file) => file.name === "new.txt"));
    await manager.dispose();
  });

  it("restores a saved directory and reports inaccessible locations", async () => {
    const userData = await temporaryDirectory("restore-userdata");
    const root = await temporaryDirectory("restore-root");
    const manager = new WatchDirectoryManager(userData, 40);
    await manager.setDirectory(root);
    await manager.dispose();

    const restored = new WatchDirectoryManager(userData, 40);
    expect((await restored.initialize()).state.directory).toBe(path.resolve(root));
    await restored.dispose();

    const missing = new WatchDirectoryManager(await temporaryDirectory("missing-userdata"), 40);
    const snapshot = await missing.setDirectory(path.join(root, "does-not-exist"));
    expect(snapshot.state.phase).toBe("inaccessible");
    expect(snapshot.state.message).toContain("不存在");
    await missing.dispose();
  });

  it("stops reporting an active watcher after the monitored directory disappears", async () => {
    const manager = new WatchDirectoryManager(await temporaryDirectory("removed-userdata"), 40);
    const root = await temporaryDirectory("removed-root");
    await manager.setDirectory(root);
    await rm(root, { recursive: true });

    const snapshot = await manager.rescan();

    expect(snapshot.state.phase).toBe("inaccessible");
    expect(snapshot.state.isWatching).toBe(false);
    await manager.dispose();
  });

  it("only resolves registered first-level image identifiers for preview", async () => {
    const manager = new WatchDirectoryManager(await temporaryDirectory("preview-userdata"), 40);
    const root = await temporaryDirectory("preview-root");
    await writeFile(path.join(root, "image.png"), "not-a-real-png", "utf8");
    await manager.setDirectory(root);
    const image = manager.getFiles()[0];

    expect(await manager.getRegisteredImagePath(image.id)).toBe(path.join(root, "image.png"));
    expect(await manager.getRegisteredImagePath("outside-the-registry")).toBeNull();
    await manager.dispose();
  });

  it("bounds text previews and rejects missing or unregistered identifiers", async () => {
    const manager = new WatchDirectoryManager(await temporaryDirectory("text-preview-userdata"), 40);
    const root = await temporaryDirectory("text-preview-root");
    const target = path.join(root, "大量日志.log");
    await writeFile(target, "字".repeat(40_000), "utf8");
    await manager.setDirectory(root);
    const file = manager.getFiles()[0];

    const preview = await manager.readRegisteredTextPreview(file.id);
    expect(Buffer.byteLength(preview?.text ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024 + 3);
    expect(preview?.truncated).toBe(true);
    expect(await manager.readRegisteredTextPreview("f".repeat(64))).toBeNull();
    expect(await manager.getRegisteredActionPath("f".repeat(64))).toBeNull();

    await rm(target);
    expect(await manager.getRegisteredActionPath(file.id)).toBeNull();
    await manager.dispose();
  });

  it("rejects a registered identifier if its record is rewritten outside the monitored root", async () => {
    const manager = new WatchDirectoryManager(await temporaryDirectory("outside-record-userdata"), 40);
    const root = await temporaryDirectory("outside-record-root");
    const outside = await temporaryDirectory("outside-record-target");
    await writeFile(path.join(root, "inside.log"), "inside", "utf8");
    const outsideTarget = path.join(outside, "outside.log");
    await writeFile(outsideTarget, "outside", "utf8");
    await manager.setDirectory(root);
    const original = manager.getFiles()[0];

    (manager as unknown as { files: FileRecord[] }).files = [{ ...original, absolutePath: outsideTarget }];
    expect(await manager.getRegisteredActionPath(original.id)).toBeNull();
    await manager.dispose();
  });

  it("only resolves registered media and PDF previews inside the monitored root", async () => {
    const manager = new WatchDirectoryManager(await temporaryDirectory("media-preview-userdata"), 40);
    const root = await temporaryDirectory("media-preview-root");
    await writeFile(path.join(root, "clip.mp4"), "video", "utf8");
    await writeFile(path.join(root, "notes.pdf"), "%PDF-1.4\n", "utf8");
    await writeFile(path.join(root, "archive.zip"), "archive", "utf8");
    await manager.setDirectory(root);
    const byName = new Map(manager.getFiles().map((file) => [file.name, file]));

    expect(await manager.getRegisteredPreview(byName.get("clip.mp4")!.id)).toEqual({
      absolutePath: path.join(root, "clip.mp4"),
      mimeType: "video/mp4",
    });
    expect((await manager.getRegisteredPreview(byName.get("notes.pdf")!.id))?.mimeType).toBe("application/pdf");
    expect(await manager.getRegisteredPreview(byName.get("archive.zip")!.id)).toBeNull();
    expect(await manager.getRegisteredPreview("e".repeat(64))).toBeNull();
    await manager.dispose();
  });
});
