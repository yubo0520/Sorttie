import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { JianyingReference, JianyingFileProtection } from "../shared/contracts";
import type { ProtectionConclusion } from "./organizationPlan";

const normalize = (value: string) => path.win32.normalize(value).toLowerCase();
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Read-only, bounded parser. No decoding of proprietary formats, material-library
// inference, media reads, recursive filesystem search, or following links.
export async function scanJianying(root: string | null) {
  const references: JianyingReference[] = [];
  let incomplete = 0, bytesRead = 0, documents = 0;
  if (!root) return { root, rootAccessible: false, incomplete, references };
  async function safe(target: string, directory: boolean) {
    const relative = path.relative(root!, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_root");
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())
      || normalize(await realpath(target)) !== normalize(path.resolve(target))) throw new Error("unsafe_path");
    return stats;
  }
  async function children(target: string) {
    await safe(target, true);
    const entries = await readdir(target, { withFileTypes: true });
    if (entries.length > 500) { incomplete++; return entries.slice(0, 500); }
    return entries;
  }
  async function read(target: string) {
    const stats = await safe(target, false);
    if (++documents > 1000 || stats.size > 8 * 1024 * 1024 || bytesRead + stats.size > 64 * 1024 * 1024) throw new Error("scan_limit");
    const handle = await open(target, "r");
    try {
      const before = await handle.stat();
      if (before.ino !== stats.ino || before.dev !== stats.dev || before.size !== stats.size) throw new Error("changed");
      const prefix = Buffer.alloc(128);
      const header = await handle.read(prefix, 0, prefix.length, 0);
      if (!/^[\s\uFEFF]*[\[{]/.test(prefix.subarray(0, header.bytesRead).toString("utf8"))) throw new Error("opaque_format");
      bytesRead += stats.size;
      const buffer = Buffer.alloc(stats.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      const current = await safe(target, false);
      if (offset !== stats.size || after.mtimeMs !== stats.mtimeMs || current.ino !== stats.ino || current.mtimeMs !== stats.mtimeMs) throw new Error("changed");
      return { data: JSON.parse(buffer.subarray(0, offset).toString("utf8").replace(/^\uFEFF/, "")) as unknown, at: stats.mtime.toISOString(), revision: `${stats.size}:${stats.mtimeMs}` };
    } finally { await handle.close(); }
  }
  async function timeline(target: string, project: string, timelineId: string, kind: "current" | "backup") {
    const { data, at, revision } = await read(target);
    if (!object(data) || !Array.isArray(data.tracks) || !object(data.materials)) throw new Error("unsupported_schema");
    const ids = new Set<string>();
    for (const track of data.tracks) {
      if (!object(track) || !Array.isArray(track.segments)) throw new Error("unsupported_track");
      for (const segment of track.segments) {
        if (!object(segment) || typeof segment.material_id !== "string") throw new Error("unsupported_segment");
        ids.add(segment.material_id);
      }
    }
    const found = new Set<string>();
    for (const [group, items] of Object.entries(data.materials)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!object(item) || typeof item.id !== "string" || !ids.has(item.id)) continue;
        found.add(item.id);
        if (group === "drafts") { incomplete++; continue; } // Nested composites not resolved in this slice.
        if (typeof item.path !== "string" || !item.path) continue;
        if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(item.path)) { incomplete++; continue; }
        references.push({ project, timeline: timelineId, kind, source: target, observedAt: at, revision, filePath: item.path });
      }
    }
    if ([...ids].some((id) => !found.has(id))) incomplete++;
  }
  async function backups(folder: string, project: string, id: string) {
    try {
      const entries = (await children(folder)).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.bak$/i.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name));
      if (entries.length > 32) incomplete++;
      // Every readable historical snapshot is weak evidence, never current proof.
      for (const entry of entries.slice(0, 32)) {
        try { await timeline(path.join(folder, entry.name), project, id, "backup"); } catch { /* unreadable backup is not proof of no reference */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete++; }
  }
  let projects: Awaited<ReturnType<typeof children>>;
  try {
    projects = await children(root);
  } catch {
    return { root, rootAccessible: false, incomplete: incomplete + 1, references };
  }
  try {
    for (const project of projects.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))) {
      const folder = path.join(root, project.name);
      try {
        await safe(folder, true);
        let ids: string[] | null = null;
        let mainTimeline = "main";
        try {
          const { data } = await read(path.join(folder, "Timelines", "project.json"));
          if (!object(data) || !Array.isArray(data.timelines)) throw new Error("unsupported_manifest");
          ids = data.timelines.filter((item) => object(item) && item.is_marked_delete !== true).map((item) => {
            if (!object(item) || typeof item.id !== "string" || !/^[a-z0-9-]{1,100}$/i.test(item.id)) throw new Error("unsafe_timeline");
            return item.id;
          });
          if (ids.length > 64) throw new Error("timeline_limit");
          if (typeof data.main_timeline_id === "string" && ids.includes(data.main_timeline_id)) mainTimeline = data.main_timeline_id;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") { incomplete++; ids = []; }
        }
        for (const id of ids ?? ["main"]) {
          const content = ids ? path.join(folder, "Timelines", id, "draft_content.json") : path.join(folder, "draft_content.json");
          try { await timeline(content, project.name, id, "current"); } catch { incomplete++; }
          if (ids) await backups(path.join(folder, ".backup", id), project.name, id);
        }
        await backups(path.join(folder, ".backup"), project.name, mainTimeline);
      } catch { incomplete++; }
    }
  } catch { incomplete++; }
  // Keep newest evidence per project/timeline/kind/file; bound IPC payloads.
  const unique = new Map<string, JianyingReference>();
  for (const reference of references) {
    const key = JSON.stringify([reference.project, reference.timeline, reference.kind, normalize(reference.filePath)]);
    const previous = unique.get(key);
    if (!previous || previous.observedAt < reference.observedAt) unique.set(key, reference);
  }
  return { root, rootAccessible: true, incomplete, references: [...unique.values()].sort((a, b) => a.source.localeCompare(b.source) || a.filePath.localeCompare(b.filePath)) };
}

// Probe only explicit, conventional roots. This never searches a drive or
// follows a link, and allows the main process to connect a normal Jianying
// installation without making the user find an application-internal folder.
export async function findSafeJianyingRoot(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    try {
      const stats = await lstat(resolved);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      if (normalize(await realpath(resolved)) !== normalize(resolved)) continue;
      return resolved;
    } catch {
      // A missing conventional location is expected; try the next exact path.
    }
  }
  return null;
}

export function fileProtection(scan: Awaited<ReturnType<typeof scanJianying>>, fileId: string, filePath: string): JianyingFileProtection {
  const references = scan.references.filter((item) => normalize(item.filePath) === normalize(filePath));
  const level = references.some((item) => item.kind === "current") ? "current" : references.length ? "backup" : "none";
  return { fileId, level, references, confirmation: level === "backup" ? JSON.stringify(references) : null };
}

export function protectionConclusion(protection: JianyingFileProtection): ProtectionConclusion {
  return { level: protection.level === "current" ? "strong_block" : protection.level === "backup" ? "weak_warning" : "none",
    summary: protection.level === "current" ? "剪映时间线引用，禁止移动" : protection.level === "backup" ? "剪映时间线备份引用，需确认" : "未发现引用记录，不代表未被使用",
    evidence: protection.references.map((item) => ({ kind: item.kind, source: item.source, observedAt: item.observedAt, detail: JSON.stringify(item) })) };
}
