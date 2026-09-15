import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(__dirname, "..");
const artifactRoot = process.env.SORTTIE_SCREENSHOT_ROOT ?? path.join(appRoot, "artifacts", "screenshots");
const screenshotRoot = path.join(artifactRoot, "read-only-chain");
const compactScreenshotRoot = path.join(artifactRoot, "compact-activity-center");
const recentActivityScreenshotRoot = path.join(artifactRoot, "recent-file-activity");
const interactionScreenshotRoot = path.join(artifactRoot, "file-interaction-states");
const operationScreenshotRoot = path.join(os.tmpdir(), "sorttie-multi-file-operation-proof");
const temporaryRoots: string[] = [];

for (const profile of [
  { name: "minimum", width: 960, height: 540, scale: 1 },
  { name: "default", width: 1120, height: 600, scale: 1 },
  { name: "wide", width: 1600, height: 850, scale: 1 },
  { name: "dpi150", width: 1600, height: 850, scale: 1.5 },
  { name: "maximized", width: 1920, height: 1080, scale: 1, maximized: true },
]) {
  test(`${profile.name} Jianying references skip, confirm, recheck and preserve undo`, async () => {
    const fixture = await createFixture(`jianying-${profile.name}`);
    const drafts = path.join(fixture.base, "drafts"), currentProject = path.join(drafts, "正在剪辑"), oldProject = path.join(drafts, "历史工程");
    await mkdir(currentProject, { recursive: true }); await mkdir(path.join(oldProject, ".backup"), { recursive: true });
    const makeDraft = (name: string) => JSON.stringify({ tracks: [{ segments: [{ material_id: "clip" }] }], materials: { videos: [{ id: "clip", path: path.join(fixture.watchDirectory, name) }] } });
    await writeFile(path.join(currentProject, "draft_content.json"), makeDraft("运行记录.log"));
    await writeFile(path.join(oldProject, "draft_content.json"), "opaque-current");
    await writeFile(path.join(oldProject, ".backup", "20260904.load.bak"), makeDraft("素材包.zip"));
    const draftBefore = await readFile(path.join(currentProject, "draft_content.json"));
    const destination = path.join(fixture.base, "organized"); await mkdir(destination);
    const { electronApp, page } = await launch(profile, fixture, "mock", destination, { SORTTIE_TEST_JIANYING_ROOT: drafts });
    const proof = path.join(artifactRoot, "jianying");
    try {
      await recentFile(page, "运行记录.log").locator(".activity-open").click();
      await page.getByRole("tab", { name: "来源", exact: true }).click();
      await expect(page.getByTestId("jianying-detail")).toContainText("正在使用，已保持原位");
      await expect(page.getByTestId("jianying-detail")).toContainText("正在剪辑");
      expect(JSON.parse(await readFile(path.join(fixture.userData, "jianying-root.json"), "utf8"))).toEqual({ directory: drafts });
      await screenshot(page, `${profile.name}-detail`, proof);
      await electronApp.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog; });
      await page.getByRole("button", { name: "更换草稿目录" }).click();
      expect(JSON.parse(await readFile(path.join(fixture.userData, "jianying-root.json"), "utf8"))).toEqual({ directory: drafts });
      await page.getByRole("button", { name: "关闭详情", exact: true }).click();
      await openPending(page); await page.getByTestId("management-toggle").click();
      for (const name of ["运行记录.log", "素材包.zip", "特殊 #素材.xyz"]) await pendingRow(page, name).click();
      await page.getByRole("button", { name: "整理 3 项" }).click();
      await page.getByRole("button", { name: "全部放到同一位置", exact: true }).click();
      await expect(page.getByTestId("execute-organization")).toBeVisible();
      await expect(page.getByTestId("jianying-review")).toContainText("2 项剪映素材保持原位");
      await expect(page.getByTestId("jianying-review")).not.toContainText("备份引用，已跳过");
      await screenshot(page, `${profile.name}-review-summary`, proof);
      await page.getByTestId("jianying-review").getByRole("button", { name: "查看依据" }).click();
      const risk = page.getByTestId("jianying-review").locator(".protection-evidence-item").filter({ hasText: "素材包.zip" });
      await expect(risk).toContainText("历史备份");
      await screenshot(page, `${profile.name}-review`, proof);
      await risk.getByRole("button", { name: "继续整理" }).click();
      await page.getByRole("button", { name: "全部放到同一位置", exact: true }).click();
      await page.getByTestId("execute-organization").click();
      await expect(page.getByTestId("batch-results")).toContainText("素材包.zip");
      await expect(page.getByTestId("undo-organization")).toHaveText("撤销已整理的 2 项");
      await expect(stat(path.join(fixture.watchDirectory, "运行记录.log"))).resolves.toBeTruthy();
      await page.getByTestId("undo-organization").click();
      await expect(page.getByRole("heading", { name: "批量撤销完成" })).toBeVisible();
      for (const name of ["运行记录.log", "素材包.zip", "特殊 #素材.xyz"]) await expect(stat(path.join(fixture.watchDirectory, name))).resolves.toBeTruthy();
      expect(await readFile(path.join(currentProject, "draft_content.json"))).toEqual(draftBefore);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await electronApp.close(); }
  });
}

for (const width of [960, 1120]) {
  test(`favorites persist and synchronize without changing files at ${width}`, async () => {
    const fixture = await createCompactFixture(`favorites-${width}`);
    const before = await directoryFingerprint(fixture.watchDirectory);
    const profile = { width, height: width === 960 ? 540 : 600, scale: 1 };
    let running = await launch(profile, fixture);
    const proof = path.join(artifactRoot, "favorites");
    const name = "旅行记录_雪山日出.bmp";
    try {
      let page = running.page;
      await page.getByRole("button", { name: "图标视图", exact: true }).click();
      const card = recentFile(page, name);
      await card.locator(".card-favorite").click();
      await expect(card.locator(".card-favorite")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      await card.locator(".activity-open").click();
      await expect(page.getByTestId("detail-panel").getByRole("button", { name: "取消收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
      await screenshot(page, `${width}-card-and-detail`, proof);
      await running.electronApp.close();
      running = await launch(profile, fixture);
      page = running.page;
      await page.getByRole("button", { name: "图标视图", exact: true }).click();
      await expect(recentFile(page, name).locator(".card-favorite")).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("menuitemcheckbox", { name: "仅看收藏" }).click();
      await expect(page.locator(".card-favorite")).toHaveCount(1);
      await screenshot(page, `${width}-favorites-filter`, proof);
      await recentFile(page, name).locator(".card-favorite").click();
      await expect(page.getByText("当前目录没有匹配的收藏")).toBeVisible();
      await screenshot(page, `${width}-empty`, proof);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const checks = await page.evaluate(async () => {
        const unknown = await window.sorttie.setFileFavorite("0".repeat(64), true);
        let rejected = false;
        try { await window.sorttie.setFileFavorite("C:\\outside.png", true); } catch { rejected = true; }
        return { unknown, rejected };
      });
      expect(checks.unknown.ok).toBe(false);
      expect(checks.rejected).toBe(true);
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
    } finally { await running.electronApp.close(); }
  });
}

for (const profile of [
  { name: "default", width: 1120, height: 600, scale: 1 },
  { name: "minimum", width: 960, height: 540, scale: 1 },
  { name: "wide", width: 1600, height: 850, scale: 1 },
  { name: "dpi150", width: 1600, height: 850, scale: 1.5 },
]) {
  test(`${profile.name} restores the reference composition with real card content`, async () => {
    const fixture = await createFixture(`reference-${profile.name}`, "empty");
    const { electronApp, page } = await launch(profile, fixture);
    const proof = path.join(artifactRoot, "reference-restoration");
    try {
      const media = await page.evaluate(async () => {
        const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 180;
        const context = canvas.getContext("2d")!;
        const sky = context.createLinearGradient(0, 0, 0, canvas.height);
        sky.addColorStop(0, "#9bbbd0"); sky.addColorStop(0.6, "#e8b780"); sky.addColorStop(1, "#4b625f");
        context.fillStyle = sky; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#334846"; context.beginPath(); context.moveTo(0, 135); context.lineTo(135, 75); context.lineTo(235, 135); context.fill();
        context.fillStyle = "#48625d"; context.beginPath(); context.moveTo(155, 135); context.lineTo(315, 60); context.lineTo(480, 135); context.fill();
        context.fillStyle = "rgba(238, 202, 144, .8)"; context.fillRect(0, 135, canvas.width, 45);
        const imageBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG fixture failed")), "image/png"));
        const stream = canvas.captureStream(20);
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const videoResult = new Promise<number[]>((resolve) => { recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
        recorder.start();
        let frame = 0;
        const timer = setInterval(() => {
          context.fillStyle = "#d78060";
          context.fillRect(18 + (frame % 40) * 5, 105, 36, 18);
          frame += 1;
        }, 50);
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        clearInterval(timer); recorder.stop(); stream.getTracks().forEach((track) => track.stop());
        return {
          image: Array.from(new Uint8Array(await imageBlob.arrayBuffer())),
          video: await videoResult,
        };
      });
      const imageBytes = Buffer.from(media.image);
      const videoBytes = Buffer.from(media.video);
      const audio = silentWav(4);
      for (let i = 0; i < (audio.length - 44) / 2; i++) audio.writeInt16LE(Math.round(Math.sin(i * .16) * (0.2 + .7 * Math.abs(Math.sin(i * .003))) * 26000), 44 + i * 2);
      const contents: Array<[string, Buffer | string]> = [
        ["江面舰队背景_v4.png", imageBytes], ["军令状_final.wav", audio],
        ["Sorttie_界面评审.txt", "SORTTIE / DESIGN REVIEW\n\n文件活动界面评审\n\n01  预览优先，信息按需展开。\n02  每个文件只保留一个操作菜单。\n03  查看详情不等于加入整理。\n\n界面清晰，文件安全。"],
        ["江面舰队_镜头预览.webm", videoBytes],
        ["file-identity.ts", "export interface FileIdentity {\n  id: string;\n  name: string;\n  type: string;\n  size: number;\n  createdAt: number;\n}\n\nconst source = 'Downloads';"],
        ["设计素材包_v2.zip", "archive fixture"],
      ];
      for (const [index, [name, content]] of contents.entries()) {
        const target = path.join(fixture.watchDirectory, name); await writeFile(target, content);
        const time = new Date(Date.now() - index * 60_000); await utimes(target, time, time);
      }
      await page.evaluate(() => { localStorage.removeItem("sorttie.recentView"); localStorage.removeItem("sorttie.cardDensity"); });
      await page.reload();
      await expect(page.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
      await expect(page.getByRole("textbox", { name: "搜索最近文件" })).toBeVisible();
      const image = recentFile(page, "江面舰队背景_v4.png");
      await expect(image.locator("img")).toBeVisible();
      await screenshot(page, `${profile.name}-initial-layout`, proof);
      await expect(recentFile(page, "军令状_final.wav").locator('.card-audio-meta')).toHaveText("00:04");
      await expect(recentFile(page, "军令状_final.wav").getByText("悬停试听")).toBeVisible();
      await expect(recentFile(page, "军令状_final.wav").locator('audio')).toHaveAttribute("preload", "metadata");
      await expect(recentFile(page, "Sorttie_界面评审.txt").locator("pre")).toContainText("文件活动界面评审");
      await expect.poll(() => recentFile(page, "江面舰队_镜头预览.webm").locator("video").evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBe(480);
      await page.mouse.move(4, 4);
      await expect(page.getByText("新增 6 项", { exact: true })).toHaveCount(0);
      await screenshot(page, `${profile.name}-home`, proof);
      await expect(image.locator(".card-favorite")).toBeVisible();
      await expect(image.locator(".card-favorite")).toBeEnabled();
      await expect(image.locator(".card-favorite")).toHaveAttribute("aria-pressed", "false");
      await expect(image.locator(".activity-name")).toHaveCSS("font-size", "11px");
      await expect(image.locator(".activity-name")).toHaveCSS("font-weight", "600");
      const cardGeometry = await image.evaluate((node) => {
        const row = node.getBoundingClientRect(), star = node.querySelector(".card-favorite")!.getBoundingClientRect(), name = node.querySelector(".activity-name")!.getBoundingClientRect();
        return { contained: star.left >= row.left && star.right <= row.right && star.top >= row.top && star.bottom <= row.bottom,
          separate: star.bottom <= name.top || star.left >= name.right, height: row.height };
      });
      expect(cardGeometry.contained).toBe(true);
      expect(cardGeometry.separate).toBe(true);
      expect(cardGeometry.height).toBeLessThan(200);
      await image.locator(".activity-open").click();
      await expect(page.getByRole("tab", { name: "预览", exact: true })).toHaveAttribute("aria-selected", "true");
      await expectInside(page, '[data-testid="detail-footer"]', '[data-testid="detail-panel"]');
      await screenshot(page, `${profile.name}-inspector`, proof);
      await page.getByRole("tab", { name: "信息", exact: true }).click();
      await expect(page.getByRole("heading", { name: "基本信息" })).toBeVisible();
      await expect(page.getByTestId("detail-panel").locator(".file-preview")).toHaveCount(0);
      await page.getByRole("tab", { name: "来源", exact: true }).click();
      await expect(page.getByRole("heading", { name: "来源轨迹" })).toBeVisible();
      await page.getByRole("button", { name: "编辑整理信息", exact: true }).click();
      await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "关闭详情", exact: true }).click();
      await image.locator(".preview-trigger").hover();
      await expect(page.getByTestId("hover-preview").locator("img")).toBeVisible();
      await screenshot(page, `${profile.name}-hover`, proof);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await electronApp.close(); }
  });
}

for (const profile of [
  { name: "960x540", width: 960, height: 540, scale: 1 },
  { name: "1120x600", width: 1120, height: 600, scale: 1 },
  { name: "1600x850", width: 1600, height: 850, scale: 1 },
  { name: "1920x1080-150", width: 1920, height: 1080, scale: 1.5 },
]) {
  test(`${profile.name} consolidated cards keep menus, hover and inspector separate`, async () => {
    const fixture = await createCompactFixture(`consolidated-${profile.name}`);
    const before = await directoryFingerprint(fixture.watchDirectory);
    const { electronApp, page } = await launch(profile, fixture);
    const proof = path.join(artifactRoot, "consolidated-cards");
    try {
      await page.getByRole("button", { name: "图标视图", exact: true }).click();
      await expect(page.getByTestId("workspace")).toHaveAttribute("data-density", "medium");
      const image = recentFile(page, "旅行记录_雪山日出.bmp");
      await expect(image.locator("img")).toBeVisible();
      const more = image.getByRole("button", { name: /的操作$/ });
      await page.mouse.move(12, 12);
      await expect(more).toHaveCSS("opacity", "0");
      await screenshot(page, `${profile.name}-cards`, proof);
      await page.evaluate(() => {
        const events: string[] = [];
        (window as unknown as { previewEvents: string[] }).previewEvents = events;
        for (const event of ["scroll", "wheel", "pointerdown", "visibilitychange", "blur", "resize", "mouseenter", "mouseleave"])
          window.addEventListener(event, (e) => events.push(`${event}:${(e.target as HTMLElement)?.className ?? "window"}`), true);
      });
      await image.locator(".preview-trigger").hover();
      try { await expect(page.getByTestId("hover-preview").locator("img")).toBeVisible(); }
      catch (error) {
        await test.info().attach("hover-events", { body: JSON.stringify(await page.evaluate(() => ({ events: (window as unknown as { previewEvents: string[] }).previewEvents, focused: document.hasFocus(), visibility: document.visibilityState }))), contentType: "application/json" });
        throw error;
      }
      await screenshot(page, `${profile.name}-hover`, proof);
      await page.mouse.move(20, 20);
      await expect(page.getByTestId("hover-preview")).toHaveCount(0);
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("file-context-menu")).toBeVisible();
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      await expectInside(page, '[data-testid="file-context-menu"]', "body");
      await screenshot(page, `${profile.name}-menu`, proof);
      await page.keyboard.press("Escape");
      await image.locator(".activity-open").click();
      await expect(page.getByTestId("detail-file-name")).toHaveText("旅行记录_雪山日出.bmp");
      await expectInside(page, '[data-testid="detail-footer"]', '[data-testid="detail-panel"]');
      if (profile.width >= 1080) {
        await expect(page.getByTestId("drawer-backdrop")).not.toBeVisible();
        const workspace = await page.getByTestId("workspace").boundingBox();
        const detail = await page.getByTestId("detail-panel").boundingBox();
        expect(workspace!.x + workspace!.width).toBeLessThanOrEqual(detail!.x + 1);
        await recentFile(page, "宁愿纯音乐.wav").locator(".activity-open").click();
        await expect(page.getByTestId("detail-file-name")).toHaveText("宁愿纯音乐.wav");
      } else {
        await expect(page.getByTestId("drawer-backdrop")).toBeVisible();
      }
      await screenshot(page, `${profile.name}-detail`, proof);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      for (const density of ["密集", "适中", "宽松"]) {
        await page.getByRole("button", { name: density, exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const rows = await page.locator(".activity-row").evaluateAll((items) => items.map((item) => {
          const icon = item.querySelector(".activity-kind")!.getBoundingClientRect();
          const name = item.querySelector(".activity-name")!.getBoundingClientRect();
          const more = item.querySelector(".file-more")!.getBoundingClientRect();
          const box = item.getBoundingClientRect();
          return (icon.bottom <= name.top || name.bottom <= icon.top) && name.right <= box.right && more.bottom <= box.bottom && more.left >= box.left;
        }));
        expect(rows.every(Boolean)).toBe(true);
      }
      const runtime = await electronApp.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return { bounds: win.getBounds(), contentBounds: win.getContentBounds(), zoomFactor: win.webContents.getZoomFactor(), scaleFactor: screen.getDisplayMatching(win.getBounds()).scaleFactor };
      });
      await writeFile(path.join(proof, `${profile.name}-runtime.json`), JSON.stringify({ generatedAt: new Date().toISOString(), mode: "production", profile, runtime,
        renderer: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })), screenshotScale: "css" }, null, 2));
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
    } finally { await electronApp.close(); }
  });
}

for (const view of ["list", "icons"] as const) {
  test(`${view} clipped bottom thumbnail previews and eye hints are contextual`, async () => {
    const fixture = await createFixture(`clipped-${view}`, "empty");
    for (let i = 0; i < 30; i++) await writeFile(path.join(fixture.watchDirectory, `${String(i).padStart(2, "0")}.bmp`), landscapeBitmap());
    const { electronApp, page } = await launch({ name: "minimum", width: 960, height: 540, scale: 1 }, fixture);
    try {
      if (view === "icons") {
        await page.getByRole("button", { name: "图标视图", exact: true }).click();
        await page.getByRole("button", { name: "密集", exact: true }).click();
      }
      const target = page.locator(".activity-row").nth(view === "icons" ? 18 : 12);
      await target.evaluate((row) => {
        const body = row.closest(".recent-body")!;
        body.scrollTop += row.getBoundingClientRect().top - (body.getBoundingClientRect().bottom - 30);
      });
      await expect(target.locator("img")).toBeVisible();
      const body = await page.locator(".recent-body").boundingBox();
      const row = await target.boundingBox();
      expect(row!.y + row!.height).toBeGreaterThan(body!.y + body!.height);
      await page.getByRole("button", { name: "更多操作", exact: true }).hover();
      await expect(target.locator(".preview-eye")).toHaveCSS("opacity", "0");
      if (view === "list") {
        await page.mouse.move(row!.x + 180, row!.y + 15);
        await expect(target.locator(".preview-eye")).toHaveCSS("opacity", "1");
        await expect(page.getByTestId("hover-preview")).toHaveCount(0);
      }
      const icon = await target.locator(".preview-trigger").boundingBox();
      await page.mouse.move(icon!.x + icon!.width / 2, Math.min(icon!.y + 10, body!.y + body!.height - 3));
      const bubble = page.getByTestId("hover-preview");
      await expect(bubble.locator("img")).toBeVisible();
      await expect(bubble).toHaveAttribute("data-side", "above");
      const box = await bubble.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(body!.y);
      expect(box!.y + box!.height).toBeLessThan(row!.y);
      await screenshot(page, `${view}-bottom-preview`, path.join(artifactRoot, "clipped-hover"));
      await page.getByRole("button", { name: "更多操作", exact: true }).hover();
      await expect(target.locator(".preview-eye")).toHaveCSS("opacity", "0");
      await expect(bubble).toHaveCount(0);
    } finally { await electronApp.close(); }
  });
}

test("transient notice has no close action and disappears after three seconds", async () => {
  const fixture = await createCompactFixture("notice-timeout");
  const { electronApp, page } = await launch({ name: "960x540", width: 960, height: 540, scale: 1 }, fixture);
  try {
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const notice = page.locator(".live-notice");
    await expect(notice).toHaveText("设置将在后续接入");
    await expect(notice.getByRole("button")).toHaveCount(0);
    await screenshot(page, "01-notice-no-close", path.join(artifactRoot, "notices"));
    await expect(notice).toHaveCount(0, { timeout: 4000 });
  } finally { await electronApp.close(); }
});

for (const profile of [
  { name: "1120x600-100", width: 1120, height: 600, scale: 1 },
  { name: "960x540-100", width: 960, height: 540, scale: 1 },
  { name: "1600x850-100", width: 1600, height: 850, scale: 1 },
  { name: "1600x850-150", width: 1600, height: 850, scale: 1.5 },
  { name: "1920x1080-maximized", width: 1920, height: 1080, scale: 1, maximized: true },
]) {
  test(`${profile.name} compact icon shelf preserves search, cache and file interactions`, async () => {
    const fixture = await createCompactFixture(`icon-shelf-${profile.name}`);
    for (let i = 0; i < 6; i++) await writeFile(path.join(fixture.watchDirectory, `参考图片_${i}.bmp`), landscapeBitmap(i % 2 ? 240 : 640, i % 2 ? 640 : 360));
    const before = await directoryFingerprint(fixture.watchDirectory);
    const { electronApp, page } = await launch(profile, fixture);
    const proof = path.join(artifactRoot, "icon-shelf");
    try {
      await page.getByRole("button", { name: "图标视图", exact: true }).click();
      await page.getByRole("button", { name: "密集", exact: true }).click();
      await expect(page.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      const image = recentFile(page, "旅行记录_雪山日出.bmp");
      await expect(image.locator("img")).toBeVisible();
      const url = await image.locator("img").getAttribute("src");
      const columns = await page.locator(".activity-list").evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(" ").length);
      expect(columns).toBeGreaterThanOrEqual(6);
      if (profile.width === 960) expect(columns).toBe(6);
      if (profile.width >= 1600) expect(columns).toBeGreaterThan(6);
      const geometry = await page.locator(".activity-row").evaluateAll((rows) => rows.map((row) => {
        const icon = row.querySelector(".activity-kind")!.getBoundingClientRect();
        const name = row.querySelector(".activity-name")!.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return { overlap: icon.bottom > name.top, outside: name.right > box.right || name.left < box.left };
      }));
      expect(geometry.every((item) => !item.overlap && !item.outside)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await screenshot(page, `${profile.name}-grid`, proof);
      const eye = image.locator(".preview-eye");
      await expect(eye).toHaveCSS("opacity", "0");
      await image.locator(".preview-trigger").hover();
      await expect(eye).toHaveCSS("opacity", "1");
      expect(await page.locator(".activity-row .preview-eye").evaluateAll((eyes) => eyes.filter((item) => getComputedStyle(item).opacity === "1").length)).toBe(1);
      await screenshot(page, `${profile.name}-eye-hover`, proof);
      await page.getByRole("button", { name: "图标视图", exact: true }).hover();
      await expect(eye).toHaveCSS("opacity", "0");
      await page.getByRole("button", { name: "图标视图", exact: true }).focus();
      await page.keyboard.press("Tab");
      await image.locator(".activity-open").focus();
      await expect(eye).toHaveCSS("opacity", "1");
      await page.getByRole("button", { name: "图标视图", exact: true }).focus();
      await expect(eye).toHaveCSS("opacity", "0");
      await image.click({ button: "right" });
      await expect(page.getByTestId("file-context-menu")).toBeVisible();
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await image.click();
      await expect(page.getByTestId("detail-file-name")).toHaveText("旅行记录_雪山日出.bmp");
      await expect(page.getByTestId("detail-panel").locator(".file-preview img")).toHaveAttribute("src", url!);
      await screenshot(page, `${profile.name}-detail`, proof);
      await page.getByRole("button", { name: "关闭详情", exact: true }).click();
      await page.getByRole("textbox", { name: "搜索最近文件" }).focus();
      await page.getByRole("textbox", { name: "搜索最近文件" }).fill("雪山日出");
      await expect(page.locator(".activity-row")).toHaveCount(1);
      await page.getByRole("button", { name: "列表视图", exact: true }).click();
      await expect(page.locator(".activity-row")).toHaveCount(1);
      await expect(image.locator("img")).toHaveAttribute("src", url!);
      await expect(eye).toHaveCSS("opacity", "0");
      await page.getByRole("button", { name: "图标视图", exact: true }).click();
      await expect(page.getByRole("textbox")).toHaveValue("雪山日出");
      await screenshot(page, `${profile.name}-search`, proof);
      await page.getByRole("textbox").press("Escape");
      await page.reload();
      await expect(page.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
      await page.getByRole("navigation").getByRole("button", { name: /待整理/ }).click();
      await expect(page.getByTestId("management-toggle")).toHaveText("管理");
      await page.getByRole("navigation").getByRole("button", { name: "最近文件" }).click();
      await expect(page.getByTestId("workspace")).toHaveAttribute("data-view", "icons");
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
    } finally { await electronApp.close(); }
  });
}

test("visible thumbnails beyond eight load without clicking and share hover/detail cache", async () => {
  const fixture = await createFixture("visible-images", "empty");
  const { electronApp, page } = await launch(defaultProfile, fixture);
  const proof = path.join(artifactRoot, "visible-thumbnails");
  try {
    const png = await page.evaluate(async (bitmap) => {
      const image = new Image();
      image.src = `data:image/bmp;base64,${bitmap}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1];
    }, landscapeBitmap().toString("base64"));
    expect(Buffer.from(png, "base64").subarray(1, 4).toString()).toBe("PNG");
    for (let i = 0; i < 40; i++) {
      const target = path.join(fixture.watchDirectory, `生成图片_${String(i).padStart(2, "0")}.png`);
      await writeFile(target, Buffer.from(png, "base64"));
      const time = new Date(Date.now() - i * 60_000);
      await utimes(target, time, time);
    }
    await page.evaluate(() => window.sorttie!.rescanWatchDirectory());
    const last = recentFile(page, "生成图片_39.png");
    await expect(last).toBeAttached();
    const first = recentFile(page, "生成图片_00.png");
    await expect(first.locator("img")).toBeVisible();
    await expect(last.locator(".activity-kind img")).toHaveCount(0);
    const before = await directoryFingerprint(fixture.watchDirectory);
    const target = recentFile(page, "生成图片_16.png");
    await target.scrollIntoViewIfNeeded();
    await expect(target.locator(".activity-kind img")).toBeVisible();
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await screenshot(page, "01-scrolled-beyond-eight", proof);
    await target.locator(".preview-trigger").hover();
    const hover = page.getByTestId("hover-preview");
    await expect(hover.locator("img")).toBeVisible();
    const url = await hover.locator("img").getAttribute("src");
    await screenshot(page, "02-hover-without-click", proof);
    await target.click();
    await expect(page.getByTestId("detail-panel").locator(".file-preview img")).toHaveAttribute("src", url!);
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await last.scrollIntoViewIfNeeded();
    await expect(last.locator(".activity-kind img")).toBeVisible();
    await screenshot(page, "03-last-image", proof);
    expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
  } finally { await electronApp.close(); }
});

type Profile = { name: string; width: number; height: number; scale: number; maximized?: boolean };
const defaultProfile: Profile = { name: "1120x600-100", width: 1120, height: 600, scale: 1 };
const responsiveProfiles: Profile[] = [
  { name: "960x540-100", width: 960, height: 540, scale: 1 },
  { name: "1260x540-100", width: 1260, height: 540, scale: 1 },
  { name: "1366x768-125", width: 1366, height: 768, scale: 1.25 },
  { name: "1600x850-100", width: 1600, height: 850, scale: 1 },
  { name: "1600x850-150", width: 1600, height: 850, scale: 1.5 },
  { name: "1920x1080-100", width: 1920, height: 1080, scale: 1 },
  { name: "1920x1080-maximized", width: 1920, height: 1080, scale: 1, maximized: true },
];

type Fixture = { base: string; userData: string; watchDirectory: string };

function bitmap2x2(): Buffer {
  const buffer = Buffer.alloc(70);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(70, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(2, 18);
  buffer.writeInt32LE(2, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(16, 34);
  Buffer.from([74, 117, 210, 104, 151, 104, 0, 0, 196, 166, 102, 238, 211, 177, 0, 0]).copy(buffer, 54);
  return buffer;
}

function silentWav(durationSeconds = 2): Buffer {
  const sampleRate = 8_000;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function landscapeBitmap(width = 640, height = 360): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const buffer = Buffer.alloc(54 + imageSize);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(imageSize, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const horizon = Math.round(height * 0.58);
      const mountain = Math.abs(x - width * 0.56) * 0.38 + height * 0.18;
      const isMountain = y > mountain && y < horizon;
      const isWater = y >= horizon;
      const blue = isWater ? 106 + Math.round((x / width) * 18) : isMountain ? 66 : 196 - Math.round((y / height) * 42);
      const green = isWater ? 128 : isMountain ? 86 : 183 - Math.round((y / height) * 30);
      const red = isWater ? 128 : isMountain ? 92 : 226 - Math.round((y / height) * 24);
      const offset = 54 + (height - 1 - y) * rowSize + x * 3;
      buffer[offset] = blue;
      buffer[offset + 1] = green;
      buffer[offset + 2] = red;
    }
  }
  return buffer;
}

async function createFixture(name: string, mode: "files" | "empty" | "unconfigured" | "inaccessible" = "files"): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), `sorttie-e2e-${name}-`));
  temporaryRoots.push(base);
  const userData = path.join(base, "user-data");
  const watchDirectory = mode === "inaccessible" ? path.join(base, "missing-directory") : path.join(base, "watched");
  await mkdir(userData, { recursive: true });
  if (mode !== "inaccessible") await mkdir(watchDirectory, { recursive: true });
  if (mode === "files") {
    const imagePath = path.join(watchDirectory, "真实图片.bmp");
    await writeFile(imagePath, bitmap2x2());
    await writeFile(path.join(watchDirectory, "示例视频.mp4"), "video-bytes", "utf8");
    await writeFile(path.join(watchDirectory, "旁白 音频.wav"), silentWav());
    await writeFile(path.join(watchDirectory, "产品说明.pdf"), "%PDF-1.4\n", "utf8");
    await writeFile(path.join(watchDirectory, "运行记录.log"), "INFO ready\n", "utf8");
    await writeFile(path.join(watchDirectory, "素材包.zip"), "zip-bytes", "utf8");
    await writeFile(path.join(watchDirectory, "特殊 #素材.xyz"), "unknown", "utf8");
    await writeFile(path.join(watchDirectory, "正在下载.crdownload"), "partial", "utf8");
    await writeFile(path.join(watchDirectory, "desktop.ini"), "[.ShellClassInfo]", "utf8");
    await mkdir(path.join(watchDirectory, "不会扫描的子目录"));
    await writeFile(path.join(watchDirectory, "不会扫描的子目录", "内部文件.log"), "hidden", "utf8");
    const imageTimestamp = new Date(Date.now() + 60_000);
    await utimes(imagePath, imageTimestamp, imageTimestamp);
  }
  if (mode !== "unconfigured") {
    await writeFile(path.join(userData, "watch-directory.json"), JSON.stringify({ directory: watchDirectory }), "utf8");
  }
  return { base, userData, watchDirectory };
}

async function createCompactFixture(name: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), `sorttie-compact-${name}-`));
  temporaryRoots.push(base);
  const userData = path.join(base, "user-data");
  const watchDirectory = path.join(base, "Downloads");
  await mkdir(userData, { recursive: true });
  await mkdir(watchDirectory, { recursive: true });
  const files: Array<[string, Buffer | string]> = [
    ["旅行记录_雪山日出.bmp", landscapeBitmap()],
    ["宁愿纯音乐.wav", silentWav()],
    ["video_【锦绣安宁】纯音乐合集_0.mp4", "mock video metadata"],
    ["Sorttie_UI系统评价_第二轮.json", "{\"status\":\"review\"}"],
    ["Sorttie_UI系统校准_第三轮.html", "<main>review</main>"],
    ["待确认素材_alpha.xyz", "unknown alpha"],
    ["设计素材包_v2.zip", "mock archive"],
    ["待确认素材_beta.asset", "unknown beta"],
    ["待确认素材_gamma.pack", "unknown gamma"],
    ["open-source-footage.crdownload", "partial"],
  ];
  const now = Date.now();
  for (const [index, [name, content]] of files.entries()) {
    const target = path.join(watchDirectory, name);
    await writeFile(target, content);
    const timestamp = new Date(now + (files.length - index) * 60_000);
    await utimes(target, timestamp, timestamp);
  }
  await writeFile(path.join(userData, "watch-directory.json"), JSON.stringify({ directory: watchDirectory }), "utf8");
  return { base, userData, watchDirectory };
}

async function launch(
  profile: Profile,
  fixture: Fixture,
  fileActionMode: "mock" | "clipboard" = "mock",
  organizationDestination?: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    args: [appRoot],
    env: {
      ...process.env,
      SORTTIE_TEST_USER_DATA: fixture.userData,
      SORTTIE_DEMO_WIDTH: String(profile.width),
      SORTTIE_DEMO_HEIGHT: String(profile.height),
      SORTTIE_DEMO_SCALE: String(profile.scale),
      SORTTIE_DEMO_MAXIMIZED: profile.maximized ? "1" : "0",
      SORTTIE_TEST_FILE_ACTIONS: fileActionMode,
      ...(organizationDestination ? { SORTTIE_TEST_ORGANIZE_DESTINATION: organizationDestination } : {}),
      ...extraEnvironment,
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await page.getByTestId("app-shell").waitFor();
    // Legacy cases explicitly exercise list mode; the reference test above
    // separately clears this preference and asserts the new card default.
    await page.getByRole("button", { name: "列表视图", exact: true }).click();
    return { electronApp, page };
  } catch (error) {
    await electronApp.close();
    throw error;
  }
}

async function screenshot(page: Page, name: string, root = screenshotRoot): Promise<string> {
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.png`);
  await page.waitForTimeout(180);
  await page.screenshot({ path: target, scale: "css" });
  return target;
}

async function directoryFingerprint(directory: string): Promise<readonly string[]> {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => {
    const metadata = await stat(path.join(directory, name));
    return `${name}|${metadata.isFile() ? "file" : "directory"}|${metadata.size}|${metadata.mtimeMs}`;
  }));
}

function fileCard(page: Page, name: string) {
  return page.locator(".home-card").filter({ hasText: name });
}

function recentFile(page: Page, name: string) {
  return page.locator(".home-card, .activity-row").filter({ hasText: name });
}

function pendingRow(page: Page, name: string) {
  return page.locator(".pending-row").filter({ hasText: name });
}

async function openPending(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /待整理/ }).click();
}

async function expectInside(page: Page, childSelector: string, parentSelector: string): Promise<void> {
  // Measure in the same frame: separate boundingBox calls can straddle an
  // inspector animation frame and compare two different positions.
  await expect.poll(() => page.evaluate(({ childSelector, parentSelector }) => {
    const child = document.querySelector(childSelector)?.getBoundingClientRect();
    const parent = document.querySelector(parentSelector)?.getBoundingClientRect();
    return !!child && !!parent && child.width > 0 && child.height > 0
      && child.left >= parent.left - 1 && child.top >= parent.top - 1
      && child.right <= parent.right + 1 && child.bottom <= parent.bottom + 1;
  }, { childSelector, parentSelector })).toBe(true);
}

test.afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })));
});

test("shows explicit unconnected, empty, and inaccessible states", async () => {
  const unconfigured = await createFixture("unconfigured", "unconfigured");
  let running = await launch(defaultProfile, unconfigured);
  try {
    await expect(running.page.getByTestId("directory-state")).toContainText("选择一个文件夹开始");
    await screenshot(running.page, "01-unconnected");
  } finally {
    await running.electronApp.close();
  }

  const empty = await createFixture("empty", "empty");
  running = await launch(defaultProfile, empty);
  try {
    await expect(running.page.getByTestId("directory-state")).toContainText("这个目录暂时没有文件活动");
    await screenshot(running.page, "05-empty-directory");
  } finally {
    await running.electronApp.close();
  }

  const inaccessible = await createFixture("inaccessible", "inaccessible");
  running = await launch(defaultProfile, inaccessible);
  try {
    await expect(running.page.getByTestId("directory-state")).toContainText("监控位置不可访问");
    await expect(running.page.getByTestId("directory-state")).toContainText(inaccessible.watchDirectory);
    await screenshot(running.page, "06-inaccessible-directory");
  } finally {
    await running.electronApp.close();
  }
});

test("runs the real top-level scan, safe thumbnail, watcher, and restart chain", async () => {
  const fixture = await createFixture("real-chain");
  const beforeReadOnlyReview = await directoryFingerprint(fixture.watchDirectory);
  let running = await launch(defaultProfile, fixture, "clipboard");
  let clipboardBefore: string | null = null;
  try {
    const { electronApp, page } = running;
    const shellState = await electronApp.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return {
        nodeIntegration: preferences.nodeIntegration,
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
        applicationMenuHidden: Menu.getApplicationMenu() === null,
      };
    });
    expect(shellState).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, applicationMenuHidden: true });

    await expect(recentFile(page, "真实图片.bmp")).toBeVisible();
    await expect(page.getByText("不会扫描的子目录")).toHaveCount(0);
    await expect(page.getByText("内部文件.log")).toHaveCount(0);
    await expect(page.locator(".sidebar-monitor button")).toHaveAttribute("title", fixture.watchDirectory);
    await screenshot(page, "02-real-directory-scan");

    await recentFile(page, "真实图片.bmp").click();
    await expect(page.getByTestId("detail-file-name")).toHaveText("真实图片.bmp");
    await expect(page.locator('[data-testid="detail-panel"] .file-preview img')).toBeVisible();
    await screenshot(page, "03-real-image-detail");

    const outsidePreviewError = await page.evaluate(async () => {
      try {
        await window.sorttie!.getImageThumbnail("D:\\outside\\private.png");
        return "no error";
      } catch (error) {
        return String(error);
      }
    });
    expect(outsidePreviewError).toContain("Invalid file identifier");
    const invalidCopyErrors = await page.evaluate(async () => {
      const invoke = async (copy: (id: string) => Promise<unknown>) => {
        try {
          await copy("D:\\outside\\private.png");
          return "no error";
        } catch (error) {
          return String(error);
        }
      };
      return [
        await invoke(window.sorttie!.copyFilePath),
        await invoke(window.sorttie!.copyFolderPath),
      ];
    });
    expect(invalidCopyErrors).toEqual([
      expect.stringContaining("Invalid file identifier"),
      expect.stringContaining("Invalid file identifier"),
    ]);
    const unknownCopy = await page.evaluate((id) => window.sorttie!.copyFilePath(id), "f".repeat(64));
    expect(unknownCopy).toMatchObject({ ok: false, code: "FILE_NOT_AVAILABLE" });

    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();

    await recentFile(page, "运行记录.log").click();
    await expect(page.getByTestId("detail-panel").locator('[data-preview-capability="text"]')).toContainText("INFO ready");
    await screenshot(page, "03b-real-text-preview", recentActivityScreenshotRoot);
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();

    await recentFile(page, "示例视频.mp4").click();
    await expect(page.getByTestId("detail-panel").locator('[data-preview-capability="video"], [data-preview-capability="unsupported"]')).toBeVisible();
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();
    await recentFile(page, "旁白 音频.wav").click();
    const audioPlayer = page.getByTestId("detail-panel").locator('[data-preview-capability="audio"]');
    await expect(audioPlayer).toBeVisible();
    await expect(audioPlayer.getByRole("button", { name: "播放" })).toBeEnabled();
    await screenshot(page, "05-audio-player", interactionScreenshotRoot);
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();
    await recentFile(page, "产品说明.pdf").click();
    await expect(page.getByTestId("detail-panel").locator('[data-preview-capability="pdf"]')).toBeVisible();
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();

    clipboardBefore = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    await recentFile(page, "运行记录.log").click({ button: "right" });
    const contextMenu = page.getByTestId("file-context-menu");
    await expect(contextMenu).toBeVisible();
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await expect(page.getByTestId("drawer-backdrop")).toHaveCount(0);
    await expect(page.getByTestId("app-shell")).not.toHaveAttribute("inert", "");
    const menuBox = await contextMenu.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height);
    await screenshot(page, "04-context-menu", recentActivityScreenshotRoot);
    await screenshot(page, "01-context-menu-no-detail", interactionScreenshotRoot);
    await contextMenu.getByRole("menuitem", { name: "复制文件路径" }).click();
    await expect(page.getByRole("status")).toContainText("已复制文件路径");
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(path.join(fixture.watchDirectory, "运行记录.log"));

    await recentFile(page, "运行记录.log").click({ button: "right" });
    await page.getByTestId("file-context-menu").getByRole("menuitem", { name: "复制文件夹路径" }).click();
    await expect(page.getByRole("status")).toContainText("已复制文件夹路径");
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(fixture.watchDirectory);
    await electronApp.evaluate(({ clipboard }, original) => clipboard.writeText(original), clipboardBefore);
    clipboardBefore = null;
    await expect(page.locator(".live-notice")).toHaveCount(0);

    await recentFile(page, "运行记录.log").click();
    await expect(page.getByTestId("detail-file-name")).toHaveText("运行记录.log");
    await expect(page.getByTestId("file-context-menu")).toHaveCount(0);
    await screenshot(page, "02-recent-detail-no-menu", interactionScreenshotRoot);
    await page.getByTestId("detail-panel").getByRole("button", { name: "所在位置" }).click();
    await expect(page.getByRole("status")).toContainText("已在资源管理器中显示");
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();

    await recentFile(page, "运行记录.log").dblclick();
    await expect(page.getByRole("status")).toContainText("已交给系统打开");
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await expect(page.locator(".live-notice")).toHaveCount(0);

    await openPending(page);
    await pendingRow(page, "正在下载.crdownload").click();
    await expect(page.getByTestId("detail-panel")).toContainText("待整理页面摘要");
    await expect(page.getByTestId("detail-file-name")).toHaveCount(0);
    await page.getByTestId("management-toggle").click();
    const downloadChoice = pendingRow(page, "正在下载.crdownload").getByRole("button", { name: /选择/ });
    await expect(downloadChoice).toBeDisabled();
    await expect(downloadChoice).toHaveAttribute("title", "下载尚未完成");
    await screenshot(page, "04-downloading-protected");

    const afterReadOnlyReview = await directoryFingerprint(fixture.watchDirectory);
    expect(afterReadOnlyReview).toEqual(beforeReadOnlyReview);

    await writeFile(path.join(fixture.watchDirectory, "刚刚新增.log"), "new file", "utf8");
    await expect(pendingRow(page, "刚刚新增.log")).toBeVisible({ timeout: 8_000 });
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /最近文件/ }).click();
    await expect(fileCard(page, "刚刚新增.log")).toBeVisible({ timeout: 8_000 });
    await screenshot(page, "02-live-just-saved", recentActivityScreenshotRoot);
    await screenshot(page, "07-new-file-observed");

    await writeFile(path.join(fixture.watchDirectory, "运行记录.log"), "INFO changed with a larger payload\n", "utf8");
    await expect(recentFile(page, "运行记录.log")).toContainText("35 B", { timeout: 8_000 });
    const removedFileId = await page.evaluate(async () => (await window.sorttie!.getCurrentFiles()).find((file) => file.name === "特殊 #素材.xyz")!.id);
    await rm(path.join(fixture.watchDirectory, "特殊 #素材.xyz"));
    await expect(recentFile(page, "特殊 #素材.xyz")).toHaveCount(0, { timeout: 8_000 });
    const removedCopy = await page.evaluate((id) => window.sorttie!.copyFolderPath(id), removedFileId);
    expect(removedCopy).toMatchObject({ ok: false, code: "FILE_NOT_AVAILABLE" });
  } finally {
    if (clipboardBefore !== null) {
      await running.electronApp.evaluate(({ clipboard }, original) => clipboard.writeText(original), clipboardBefore).catch(() => undefined);
    }
    await running.electronApp.close();
  }

  running = await launch(defaultProfile, fixture);
  try {
    await expect(running.page.getByText("刚刚新增.log", { exact: true })).toBeVisible();
    const savedConfig = JSON.parse(await readFile(path.join(fixture.userData, "watch-directory.json"), "utf8")) as { directory: string };
    expect(savedConfig.directory).toBe(fixture.watchDirectory);
  } finally {
    await running.electronApp.close();
  }
});

test("moves three confirmed files in order and keeps batch undo available", async () => {
  const fixture = await createFixture("multi-file-operation");
  const destinationDirectory = path.join(fixture.base, "organized");
  await mkdir(destinationDirectory);
  const fileNames = ["运行记录.log", "素材包.zip", "特殊 #素材.xyz"];
  const sourceContents = new Map(await Promise.all(fileNames.map(async (name) => [name, await readFile(path.join(fixture.watchDirectory, name))] as const)));
  const { electronApp, page } = await launch(defaultProfile, fixture, "mock", destinationDirectory);
  try {
    await openPending(page);
    await page.getByTestId("management-toggle").click();
    for (const name of fileNames) await pendingRow(page, name).click();
    await page.getByRole("button", { name: "整理 3 项" }).click();
    await page.getByRole("button", { name: "全部放到同一位置", exact: true }).click();
    await expect(page.getByTestId("plan-dialog")).toContainText(destinationDirectory);
    await page.getByTestId("execute-organization").click();

    await expect(page.getByRole("heading", { name: "批量整理完成" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "整理结果" })).toBeVisible();
    await expect(page.getByTestId("plan-dialog")).toContainText("成功 3 项");
    await expect(page.getByTestId("plan-dialog")).not.toContainText("失败 0 项");
    await page.waitForTimeout(500);
    await expect(page.locator(".live-notice")).toHaveCount(0);
    for (const name of fileNames) await expect(page.getByTestId("batch-results")).toContainText(`已整理至：${path.join(destinationDirectory, name)}`);
    await expect(page.getByTestId("undo-organization")).toHaveText("撤销已整理的 3 项");
    for (const name of fileNames) {
      await expect(stat(path.join(fixture.watchDirectory, name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(destinationDirectory, name))).toEqual(sourceContents.get(name));
    }
    await screenshot(page, "01-batch-organization-results", operationScreenshotRoot);

    await page.getByTestId("undo-organization").click();
    await expect(page.getByRole("heading", { name: "批量撤销完成" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "撤销结果" })).toBeVisible();
    await expect(page.getByTestId("plan-dialog")).toContainText("已撤销 3 项");
    await expect(page.getByTestId("plan-dialog")).not.toContainText("失败 0 项");
    for (const name of fileNames) await expect(page.getByTestId("batch-results")).toContainText(`已恢复至：${path.join(fixture.watchDirectory, name)}`);
    for (const name of fileNames) {
      expect(await readFile(path.join(fixture.watchDirectory, name))).toEqual(sourceContents.get(name));
      await expect(stat(path.join(destinationDirectory, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await screenshot(page, "02-batch-undo-completed", operationScreenshotRoot);
  } finally {
    await electronApp.close();
  }
});

for (const profile of [defaultProfile, ...responsiveProfiles.filter((value) => ["960x540-100", "1600x850-100", "1600x850-150", "1920x1080-maximized"].includes(value.name))]) {
test(`${profile.name} categorizes mixed files under a persisted root and safely cleans directories after undo`, async () => {
  const fixture = await createFixture("categorized-operation");
  const library = path.join(fixture.base, "Library");
  await mkdir(path.join(library, "视频"), { recursive: true });
  await writeFile(path.join(fixture.watchDirectory, "a.png"), bitmap2x2());
  await writeFile(path.join(fixture.watchDirectory, "b.mp4"), "video fixture");
  await writeFile(path.join(fixture.watchDirectory, "debug.log"), "log fixture");
  const files = [["a.png", "图片"], ["b.mp4", "视频"], ["debug.log", "代码与数据"]] as const;
  const contents = new Map(await Promise.all(files.map(async ([name]) => [name, await readFile(path.join(fixture.watchDirectory, name))] as const)));
  const proofRoot = path.join(artifactRoot, "categorized-targets", profile.name);
  let running = await launch(profile, fixture, "mock", library);
  try {
    const { page } = running;
    await openPending(page);
    await page.getByTestId("management-toggle").click();
    for (const name of [...files.map(([name]) => name), "特殊 #素材.xyz"]) await pendingRow(page, name).click();
    await page.getByRole("button", { name: "整理 4 项" }).click();
    await page.getByTestId("prepare-organization").click();
    await expect(page.getByTestId("execute-organization")).toBeEnabled();
    await expect(page.getByRole("region", { name: "等待确认去向" })).toContainText("特殊 #素材.xyz");
    for (const [, category] of files) await expect(page.getByTestId("plan-dialog")).toContainText(path.join(library, category));
    expect(await readdir(library)).toEqual(["视频"]);
    await expectInside(page, '[data-testid="execute-organization"]', '[data-testid="plan-footer"]');
    await expectInside(page, '[data-testid="plan-footer"]', '[data-testid="plan-dialog"]');
    expect(await page.getByTestId("plan-scroll").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await screenshot(page, "01-grouped-preview", proofRoot);
    await page.getByTestId("execute-organization").click();
    await expect(page.getByRole("heading", { name: "批量整理完成" })).toBeVisible();
    await expect(page.getByTestId("plan-dialog")).toContainText("成功 3 项");
    for (const [name, category] of files) {
      expect(await readFile(path.join(library, category, name))).toEqual(contents.get(name));
      await expect(stat(path.join(fixture.watchDirectory, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(fixture.watchDirectory, "特殊 #素材.xyz"), "utf8")).toBe("unknown");
    await screenshot(page, "02-mixed-files-organized", proofRoot);
    await page.getByTestId("undo-organization").click();
    await expect(page.getByRole("heading", { name: "批量撤销完成" })).toBeVisible();
    for (const [name] of files) expect(await readFile(path.join(fixture.watchDirectory, name))).toEqual(contents.get(name));
    expect(await readdir(library)).toEqual(["视频"]);
    expect(await readdir(path.join(library, "视频"))).toEqual([]);
    await screenshot(page, "03-restored-and-cleaned", proofRoot);
    expect(JSON.parse(await readFile(path.join(fixture.userData, "organization-root.json"), "utf8"))).toEqual({ directory: library });
    await running.electronApp.close();
    running = await launch(profile, fixture);
    await openPending(running.page);
    await running.page.getByTestId("management-toggle").click();
    await pendingRow(running.page, "debug.log").click();
    await running.page.getByRole("button", { name: "整理 1 项" }).click();
    await expect(running.page.getByTestId("execute-organization")).toBeEnabled();
    await expect(running.page.getByTestId("plan-dialog")).toContainText(path.join(library, "代码与数据"));
    expect(await readdir(library)).toEqual(["视频"]);
    await screenshot(running.page, "04-saved-root-after-restart", proofRoot);
  } finally {
    await running.electronApp.close();
  }
});
}

test("renders the accepted compact home, on-demand search, drawer, and Pending entry", async () => {
  const fixture = await createCompactFixture("approved-home");
  const { electronApp, page } = await launch(defaultProfile, fixture);
  try {
    await expect(page.getByRole("navigation").getByRole("button", { name: "最近文件", exact: true })).toBeVisible();
    await writeFile(path.join(fixture.watchDirectory, "旅行记录_雪山日出.bmp"), landscapeBitmap());
    await writeFile(path.join(fixture.watchDirectory, "宁愿纯音乐.wav"), silentWav(3));
    await expect(page.locator(".home-card")).toHaveCount(2);
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await expect(page.getByTestId("confirmation-strip")).toContainText("3 项需要确认");
    await expect(page.locator(".activity-row").filter({ hasText: "open-source-footage.crdownload" })).toContainText("下载中");
    await screenshot(page, "01-default-1120x600", compactScreenshotRoot);

    await page.getByRole("textbox", { name: "搜索最近文件" }).focus();
    await page.getByRole("textbox", { name: "搜索最近文件" }).fill("Sorttie_UI");
    await expect(page.locator(".activity-row")).toHaveCount(2);
    await screenshot(page, "02-search-expanded", compactScreenshotRoot);
    await page.keyboard.press("Escape");

    await recentFile(page, "旅行记录_雪山日出.bmp").click();
    await expect(page.getByTestId("detail-panel")).toHaveClass(/recent-detail-panel/);
    await expect(page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" })).toBeVisible();
    await screenshot(page, "03-file-detail-drawer", compactScreenshotRoot);
    await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();

    await page.getByTestId("confirmation-strip").getByRole("button", { name: "查看" }).click();
    await expect(page.getByRole("heading", { name: "待整理" })).toBeVisible();
    await screenshot(page, "06-enter-pending", compactScreenshotRoot);
  } finally {
    await electronApp.close();
  }
});

test("remembers a user-resized compact window", async () => {
  const fixture = await createCompactFixture("window-size");
  let running = await launch(defaultProfile, fixture);
  await running.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1184, 640);
  });
  await running.page.waitForTimeout(450);
  await running.electronApp.close();

  const electronApp = await electron.launch({
    args: [appRoot],
    env: { ...process.env, SORTTIE_TEST_USER_DATA: fixture.userData },
  });
  const page = await electronApp.firstWindow();
  await page.getByTestId("app-shell").waitFor();
  try {
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    expect(Math.abs(bounds.width - 1184)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.height - 640)).toBeLessThanOrEqual(2);
  } finally {
    await electronApp.close();
  }
});

for (const profile of responsiveProfiles) {
  test(`${profile.name} keeps the compact activity center inside its responsive shell`, async () => {
    const fixture = await createCompactFixture(profile.name);
    const { electronApp, page } = await launch(profile, fixture);
    try {
      await writeFile(path.join(fixture.watchDirectory, "旅行记录_雪山日出.bmp"), landscapeBitmap());
      await writeFile(path.join(fixture.watchDirectory, "宁愿纯音乐.wav"), silentWav(3));
      await expect(fileCard(page, "旅行记录_雪山日出.bmp")).toBeVisible({ timeout: 8_000 });
      await expectInside(page, '[data-testid="workspace-header"]', '[data-testid="workspace"]');
      await expectInside(page, ".confirmation-strip", '[data-testid="workspace"]');
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflow).toBeLessThanOrEqual(1);
      if (profile.width === 960) {
        const cards = await page.locator(".home-card").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
        expect(cards).toHaveLength(2);
        expect(cards[1]).toBeGreaterThan(cards[0]);
        const activity = page.locator(".activity-row").filter({ hasText: "Sorttie_UI系统评价_第二轮.json" });
        await activity.scrollIntoViewIfNeeded();
        await page.mouse.move(20, 20);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await activity.locator(".preview-trigger").hover();
        await page.waitForTimeout(360);
        await expect(page.getByTestId("hover-preview")).toBeVisible();
        await expect(page.getByTestId("hover-preview")).toHaveCSS("pointer-events", "none");
        await activity.click({ button: "right", position: { x: 8, y: 8 } });
        await expect(page.getByTestId("hover-preview")).toHaveCount(0);
        const menuBox = await page.getByTestId("file-context-menu").boundingBox();
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        expect(menuBox).not.toBeNull();
        expect(menuBox!.x).toBeGreaterThanOrEqual(0);
        expect(menuBox!.y).toBeGreaterThanOrEqual(0);
        expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
        expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height);
        await screenshot(page, "04-context-menu-960", interactionScreenshotRoot);
        await page.keyboard.press("Escape");

        await fileCard(page, "宁愿纯音乐.wav").click();
        await expect(page.getByTestId("detail-panel").getByRole("button", { name: "播放" })).toBeEnabled();
        await expectInside(page, ".audio-controls", '[data-testid="detail-panel"]');
        await screenshot(page, "05-audio-player-960", interactionScreenshotRoot);
        await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();
      }
      await screenshot(page, `matrix-${profile.name}`, compactScreenshotRoot);
      await fileCard(page, "旅行记录_雪山日出.bmp").click();
      await expectInside(page, '[data-testid="detail-footer"]', '[data-testid="detail-panel"]');
      if (profile.width === 1260) {
        await page.getByTestId("detail-panel").getByRole("button", { name: "关闭详情" }).click();
        await openPending(page);
        await pendingRow(page, "Sorttie_UI系统评价_第二轮.json").click();
        await expect(page.getByTestId("detail-panel")).toContainText("待整理页面摘要");
        await expect(page.getByTestId("detail-file-name")).toHaveCount(0);
        await screenshot(page, "03-pending-summary-after-click", interactionScreenshotRoot);
      }
    } finally {
      await electronApp.close();
    }
  });
}

for (const profile of [defaultProfile, responsiveProfiles[0], responsiveProfiles[3], responsiveProfiles[4], responsiveProfiles[6]]) {
  test(`${profile.name} rounded hover uses readable paper colors for prose and code`, async () => {
    const fixture = await createCompactFixture(`rounded-${profile.name}`);
    const prose = "今天的阅读记录\n\n预览只展示文件内容。\n移开鼠标，继续查看下一份文件。\n\n中文保持自然、清楚的排版，\n不使用暗底红字，也不重复文件名。";
    const code = '{\n  "project": "Sorttie",\n  "preview": {\n    "theme": "warm",\n    "说明": "只读内容预览"\n  }\n}';
    await writeFile(path.join(fixture.watchDirectory, "阅读记录.txt"), prose);
    await writeFile(path.join(fixture.watchDirectory, "Sorttie_UI系统评价_第二轮.json"), code);
    const before = await directoryFingerprint(fixture.watchDirectory);
    const { electronApp, page } = await launch(profile, fixture);
    try {
      for (const [name, content, suffix] of [["阅读记录.txt", prose, "text"], ["Sorttie_UI系统评价_第二轮.json", code, "code"], ["旅行记录_雪山日出.bmp", "", "image"]]) {
        const row = recentFile(page, name);
        await row.scrollIntoViewIfNeeded();
        await page.mouse.move(20, 20);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await row.locator(".preview-trigger").hover();
        const hover = page.getByTestId("hover-preview");
        await expect(hover).toBeVisible();
        await expect(hover).toHaveCSS("border-radius", "12px");
        await expect(hover).not.toHaveCSS("box-shadow", "none");
        await expect(hover).toHaveCSS("pointer-events", "none");
        await expectInside(page, '[data-testid="hover-preview"]', ".recent-body");
        await expect(hover.locator(".format-mark, .hover-preview-caption")).toHaveCount(0);
        if (content) {
          await expect(hover.locator("pre")).toHaveText(content);
          await expect(hover.locator("pre")).toHaveCSS("color", "rgb(52, 58, 58)");
          await expect(hover.locator(".real-text-preview")).toHaveCSS("background-color", "rgb(255, 253, 248)");
          await expect(hover.locator("pre")).toHaveCSS("font-size", "13px");
          await expect(hover.locator("pre")).toHaveCSS("font-family", suffix === "text" ? /Segoe UI/ : /Consolas/);
        } else {
          await expect.poll(() => hover.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          const box = (await hover.boundingBox())!;
          expect(box.width / box.height).toBeCloseTo(640 / 360, 2);
        }
        await screenshot(page, `${profile.name}-${suffix}`, path.join(artifactRoot, "rounded-hover"));
        await page.keyboard.press("Escape");
      }
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
    } finally { await electronApp.close(); }
  });
}

test("hover media decodes real temporary files, loops the opening segment and stops on exit", async () => {
  const fixture = await createCompactFixture("hover-playback");
  await writeFile(path.join(fixture.watchDirectory, "宁愿纯音乐.wav"), silentWav(12));
  const { electronApp, page } = await launch(defaultProfile, fixture);
  const proof = path.join(artifactRoot, "thumbnail-hover");
  let generatorClosed = false;
  try {
    // Generate a real short WebM in the test process; no external samples or user files.
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      const stream = canvas.captureStream(20);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const result = new Promise<number[]>((resolve) => {
        recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
      });
      recorder.start();
      let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = "#34565a"; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = "#d78060"; ctx.fillRect(20 + frame * 4, 60, 50, 50);
        frame++;
      }, 50);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      clearInterval(timer); recorder.stop(); stream.getTracks().forEach((track) => track.stop());
      return result;
    });
    await writeFile(path.join(fixture.watchDirectory, "播放验证.webm"), Buffer.from(bytes));
    await expect(fileCard(page, "播放验证.webm")).toBeVisible({ timeout: 8000 });
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "重新扫描", exact: true }).click();
    // A rescan retains activity kinds; restart so the registered video is in Today.
    await electronApp.close();
    generatorClosed = true;
    const restarted = await launch(defaultProfile, fixture);
    try {
      const p = restarted.page;
      const before = await directoryFingerprint(fixture.watchDirectory);
      const hover = p.getByTestId("hover-preview");
      await recentFile(p, "播放验证.webm").locator(".preview-trigger").hover();
      const video = hover.locator("video");
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBe(320);
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
      await expect(video).not.toHaveAttribute("controls");
      await video.evaluate((node) => {
        const media = node as HTMLVideoElement;
        let previous = media.currentTime;
        const samples: number[] = [];
        media.addEventListener("timeupdate", () => {
          if (media.currentTime < previous) node.setAttribute("data-repeat-from", String(previous));
          previous = media.currentTime;
          samples.push(previous);
          node.setAttribute("data-samples", JSON.stringify(samples.slice(-25)));
        });
      });
      try {
        await expect.poll(() => video.getAttribute("data-repeat-from")).not.toBeNull();
      } catch (error) {
        console.log("short WebM playback evidence", await video.evaluate((node) => {
          const media = node as HTMLVideoElement;
          return { samples: node.getAttribute("data-samples"), duration: media.duration, currentTime: media.currentTime, paused: media.paused, seeking: media.seeking, ended: media.ended, readyState: media.readyState, error: media.error?.message, seekable: Array.from({ length: media.seekable.length }, (_, i) => [media.seekable.start(i), media.seekable.end(i)]) };
        }));
        throw error;
      }
      expect(Number(await video.getAttribute("data-repeat-from"))).toBeGreaterThan(0.5);
      expect(Number(await video.getAttribute("data-repeat-from"))).toBeLessThan(2);
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(false);
      await screenshot(p, "video-content-only", proof);
      const oldVideo = await video.elementHandle();
      const audioRow = recentFile(p, "宁愿纯音乐.wav");
      await audioRow.scrollIntoViewIfNeeded();
      await p.mouse.move(20, 20);
      await p.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await audioRow.locator(".preview-trigger").hover();
      await expect(hover).toContainText("正在试听");
      expect(await oldVideo!.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true);
      const audio = hover.locator("audio");
      await audio.evaluate((node) => {
        const media = node as HTMLAudioElement;
        let previous = 0;
        media.addEventListener("timeupdate", () => {
          if (media.currentTime < previous) node.setAttribute("data-repeat-from", String(previous));
          previous = media.currentTime;
        });
      });
      await expect.poll(() => audio.getAttribute("data-repeat-from"), { timeout: 15_000 }).not.toBeNull();
      const loopBoundary = Number(await audio.getAttribute("data-repeat-from"));
      expect(loopBoundary).toBeGreaterThan(9);
      expect(loopBoundary).toBeLessThan(10.5);
      await screenshot(p, "audio-listening", proof);
      const oldAudio = await audio.elementHandle();
      await p.mouse.move(20, 20);
      await expect(hover).toHaveCount(0);
      expect(await oldAudio!.evaluate((node) => (node as HTMLAudioElement).paused)).toBe(true);
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
      const capabilities = await p.evaluate(() => {
        const media = document.createElement("video");
        return Object.fromEntries(['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"', 'video/x-msvideo', 'video/x-matroska', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4; codecs="mp4a.40.2"', 'audio/aac'].map((mime) => [mime, media.canPlayType(mime)]));
      });
      await writeFile(path.join(proof, "decoder-capabilities.json"), JSON.stringify(capabilities, null, 2));
    } finally { await restarted.electronApp.close(); }
  } finally { if (!generatorClosed) await electronApp.close(); }
});

for (const profile of [defaultProfile, responsiveProfiles[0], responsiveProfiles[3], responsiveProfiles[4], responsiveProfiles[6]]) {
  test(`${profile.name} thumbnail hover is bounded, non-interactive and independent from file actions`, async () => {
    const fixture = await createCompactFixture(`hover-${profile.name}`);
    const longName = `旅行照片_${"非常长的文件名_".repeat(12)}.bmp`;
    const lowerPath = path.join(fixture.watchDirectory, longName);
    await writeFile(lowerPath, landscapeBitmap(240, 640));
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lowerPath, oldTime, oldTime);
    const before = await directoryFingerprint(fixture.watchDirectory);
    const { electronApp, page } = await launch(profile, fixture);
    const proof = path.join(artifactRoot, "thumbnail-hover");
    try {
      const firstRow = recentFile(page, "旅行记录_雪山日出.bmp");
      const icon = firstRow.locator(".preview-trigger");
      const hover = page.getByTestId("hover-preview");
      await expect(icon.locator(".preview-eye")).toBeVisible();
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      await icon.hover();
      await expect(hover).toBeVisible();
      await expect(hover).toHaveAttribute("data-side", "below");
      await expectInside(page, '[data-testid="hover-preview"]', ".recent-body");
      await expect(hover).toHaveCSS("pointer-events", "none");
      await expect(page.getByTestId("app-shell")).not.toHaveAttribute("inert");
      await expect(hover.locator("img")).toBeVisible();
      await expect.poll(() => hover.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect.poll(async () => {
        const box = (await hover.boundingBox())!;
        return Math.abs(box.width / box.height - 640 / 360);
      }).toBeLessThan(0.01);
      await expect(hover).toHaveCSS("border-width", "0px");
      await expect(hover).toHaveCSS("border-radius", "12px");
      await expect(hover).not.toHaveCSS("box-shadow", "none");
      await expect(hover.locator(".format-mark, .hover-preview-caption")).toHaveCount(0);
      const target = (await icon.boundingBox())!;
      const overlay = (await hover.boundingBox())!;
      expect(overlay.x).toBeGreaterThan(target.x + target.width);
      expect(overlay.y).toBeGreaterThan((await firstRow.boundingBox())!.y + (await firstRow.boundingBox())!.height);
      await screenshot(page, `${profile.name}-first-row-below`, proof);
      // A vertical sweep must reach another icon, not the floating content.
      await page.evaluate(() => {
        const events: string[] = [];
        for (const name of ["mouseout", "blur", "resize", "scroll", "visibilitychange", "pointerdown", "keydown", "wheel"]) {
          window.addEventListener(name, (event) => {
            events.push(`${name}:${(event.target as HTMLElement)?.className ?? "window"}`);
            document.body.dataset.hoverEvents = JSON.stringify(events.slice(-20));
          }, true);
        }
      });
      const audio = recentFile(page, "宁愿纯音乐.wav").locator(".preview-trigger");
      await audio.hover();
      try { await expect(hover).toContainText("正在试听"); }
      catch (error) { console.log("opening dismissal events", await page.locator("body").getAttribute("data-hover-events")); throw error; }
      await expect(hover.locator("audio")).toHaveAttribute("preload", "metadata");
      await expect(hover.locator("audio")).not.toHaveAttribute("autoplay");
      await expect(hover.locator("button, input, [controls]")).toHaveCount(0);
      const oldAudio = await hover.locator("audio").elementHandle();
      await expect.poll(() => oldAudio!.evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
      await page.waitForTimeout(2200);
      try {
        await expect.poll(() => oldAudio!.evaluate((node) => (node as HTMLAudioElement).paused)).toBe(false);
      } catch (error) {
        console.log("audio hover evidence", await oldAudio!.evaluate((node) => {
          const media = node as HTMLAudioElement;
          return { connected: media.isConnected, src: media.getAttribute("src"), time: media.currentTime, duration: media.duration, paused: media.paused, ended: media.ended, error: media.error?.message, documentFocused: document.hasFocus() };
        }));
        console.log("dismissal events", await page.locator("body").getAttribute("data-hover-events"));
        throw error;
      }
      await page.keyboard.press("Escape");
      await expect(hover).toHaveCount(0);
      expect(await oldAudio!.evaluate((node) => (node as HTMLAudioElement).paused)).toBe(true);

      const lower = recentFile(page, longName);
      await lower.scrollIntoViewIfNeeded();
      await page.mouse.move(20, 20);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await lower.locator(".preview-trigger").hover();
      await expect(hover).toBeVisible();
      await expect(hover).toHaveAttribute("data-side", "above");
      await expectInside(page, '[data-testid="hover-preview"]', ".recent-body");
      await expect.poll(async () => {
        const box = (await hover.boundingBox())!;
        return Math.abs(box.width / box.height - 240 / 640);
      }).toBeLessThan(0.01);
      const lowerRect = (await lower.boundingBox())!;
      const aboveRect = (await hover.boundingBox())!;
      expect(aboveRect.y + aboveRect.height).toBeLessThan(lowerRect.y);
      expect(await lower.locator(".activity-name").getAttribute("title")).toBe(longName);
      await screenshot(page, `${profile.name}-lower-row-above`, proof);
      await lower.click({ button: "right" });
      await expect(hover).toHaveCount(0);
      await expect(page.getByTestId("file-context-menu")).toBeVisible();
      await expect(page.getByTestId("detail-panel")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await lower.click();
      await expect(page.getByTestId("detail-file-name")).toHaveText(longName);
      await expect(page.getByTestId("detail-panel").locator('[data-preview-capability="image"]')).toBeVisible();
      await page.getByRole("button", { name: "关闭详情", exact: true }).click();
      await firstRow.scrollIntoViewIfNeeded();
      await page.mouse.move(20, 20);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await icon.hover();
      await expect(hover).toBeVisible();
      await page.mouse.wheel(0, 80);
      await expect(hover).toHaveCount(0);
      await expect(recentFile(page, "设计素材包_v2.zip").locator(".preview-eye")).toHaveCount(0);
      expect(await directoryFingerprint(fixture.watchDirectory)).toEqual(before);
    } finally {
      await electronApp.close();
    }
  });
}
