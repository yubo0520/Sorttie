// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanJianying, fileProtection, findSafeJianyingRoot, protectionConclusion } from "./jianyingProtection";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sorttie-jianying-")); roots.push(root);
  const project = path.join(root, "测试工程"); await mkdir(project);
  return { root, project };
}
const content = (used = "D:/Downloads/中文 #.png", spare = "D:/Downloads/spare.png") => ({
  tracks: [{ segments: [{ material_id: "used" }] }],
  materials: { videos: [{ id: "used", path: used }, { id: "spare", path: spare }] },
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("read-only Jianying timeline evidence", () => {
  it("matches referenced IDs only, normalizes Windows paths and never reads media", async () => {
    const f = await fixture(); const source = path.join(f.project, "draft_content.json");
    await writeFile(source, JSON.stringify(content())); const before = await readFile(source);
    const scan = await scanJianying(f.root);
    expect(fileProtection(scan, "id", "d:\\downloads\\中文 #.png").level).toBe("current");
    expect(fileProtection(scan, "id", "D:/Downloads/spare.png").level).toBe("none");
    expect(scan.incomplete).toBe(0); expect(await readFile(source)).toEqual(before);
  });
  it("keeps backup evidence weak when current content is unreadable", async () => {
    const f = await fixture(); await mkdir(path.join(f.project, ".backup"));
    await writeFile(path.join(f.project, "draft_content.json"), "opaque-content");
    await writeFile(path.join(f.project, ".backup", "20260904.load.bak"), JSON.stringify(content()));
    const scan = await scanJianying(f.root); const protection = fileProtection(scan, "id", "D:/Downloads/中文 #.png");
    expect(scan.incomplete).toBeGreaterThan(0); expect(protection.level).toBe("backup");
    expect(protectionConclusion(protection).level).toBe("weak_warning");
    expect(protection.confirmation).toContain("20260904.load.bak");
  });
  it("uses each active timeline, not the stale top-level mirror", async () => {
    const f = await fixture(); const folder = path.join(f.project, "Timelines", "abc-123"); await mkdir(folder, { recursive: true });
    await writeFile(path.join(f.project, "draft_content.json"), JSON.stringify(content("D:/Downloads/stale.png")));
    await writeFile(path.join(f.project, "Timelines", "project.json"), JSON.stringify({ timelines: [{ id: "abc-123", is_marked_delete: false }] }));
    await writeFile(path.join(folder, "draft_content.json"), JSON.stringify(content()));
    const scan = await scanJianying(f.root);
    expect(fileProtection(scan, "id", "D:/Downloads/stale.png").level).toBe("none");
    expect(scan.references[0].timeline).toBe("abc-123");
  });
  it("does not follow junctions or traverse malicious timeline IDs", async () => {
    const f = await fixture(); const outside = await fixture();
    await writeFile(path.join(outside.project, "draft_content.json"), JSON.stringify(content()));
    await symlink(outside.project, path.join(f.root, "linked"), "junction");
    await mkdir(path.join(f.project, "Timelines"));
    await writeFile(path.join(f.project, "Timelines", "project.json"), JSON.stringify({ timelines: [{ id: "../../escape" }] }));
    const scan = await scanJianying(f.root); expect(scan.references).toEqual([]); expect(scan.incomplete).toBeGreaterThan(0);
  });
  it("marks relative paths and unresolved nested drafts incomplete", async () => {
    const f = await fixture();
    await writeFile(path.join(f.project, "draft_content.json"), JSON.stringify(content("materials/image.png")));
    const scan = await scanJianying(f.root); expect(scan.references).toEqual([]); expect(scan.incomplete).toBeGreaterThan(0);
  });
  it("reports inaccessible roots and never treats them as a complete clean scan", async () => {
    const f = await fixture(); const missing = await scanJianying(path.join(f.root, "missing"));
    expect(missing.incomplete).toBeGreaterThan(0); expect(missing.rootAccessible).toBe(false);
    expect(await scanJianying(null)).toEqual({ root: null, rootAccessible: false, incomplete: 0, references: [] });
  });
  it("discovers only a safe explicit draft root and never follows a junction", async () => {
    const missing = path.join(tmpdir(), `sorttie-missing-${Date.now()}`);
    const f = await fixture(); const linked = path.join(tmpdir(), `sorttie-jianying-link-${Date.now()}`);
    roots.push(linked); await symlink(f.root, linked, "junction");
    expect(await findSafeJianyingRoot(["relative", missing, linked, f.root])).toBe(path.resolve(f.root));
    expect(await findSafeJianyingRoot(["relative", missing, linked])).toBeNull();
  });
  it("does not let opaque backups consume the readable evidence byte budget", async () => {
    const f = await fixture(); await mkdir(path.join(f.project, ".backup"));
    await writeFile(path.join(f.project, "draft_content.json"), "opaque");
    for (let index = 0; index < 10; index++) await writeFile(path.join(f.project, ".backup", `z${index}.bak`), "x".repeat(7 * 1024 * 1024));
    await writeFile(path.join(f.project, ".backup", "a.bak"), JSON.stringify(content()));
    expect(fileProtection(await scanJianying(f.root), "id", "D:/Downloads/中文 #.png").level).toBe("backup");
  });
});
