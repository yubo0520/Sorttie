// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseJianyingSnapshot,
  parseLocalAiClassificationResult,
  parseFavoriteFlag,
  parseFavoriteSnapshot,
  parseFavoriteResult,
  parseFileActionResult,
  parseFileId,
  parseFileRecord,
  parseFileSnapshot,
  parseOperationId,
  parseOrganizationActionResult,
  parseOrganizationPlanRequest,
  parseOrganizationPreparationResult,
  parseOrganizationDestinationMode,
  parseOrganizationRoot,
  parseTextPreview,
  parseThumbnail,
  registeredFileUrl,
} from "./contracts";

describe("IPC runtime validation", () => {
  it("validates protection snapshots and bounds risk confirmations", () => {
    expect(parseJianyingSnapshot({ root: null, incomplete: 0, files: [] }).files).toEqual([]);
    expect(() => parseJianyingSnapshot({ root: null, incomplete: -1, files: [] })).toThrow();
    expect(() => parseJianyingSnapshot({ root: null, incomplete: 0, files: [{ fileId: "arbitrary/path", level: "none", references: [], confirmation: null }] })).toThrow();
    expect(() => parseOrganizationPlanRequest([{ fileId: "a".repeat(64), category: "图片", protectionConfirmation: true }])).toThrow();
    expect(() => parseOrganizationPlanRequest([{ fileId: "a".repeat(64), category: "图片", protectionConfirmation: "a".repeat(262145) }])).toThrow();
    expect(parseOrganizationPlanRequest([{ fileId: "a".repeat(64), category: "图片", protectionConfirmation: "evidence" }])[0].protectionConfirmation).toBe("evidence");
  });
  it("validates favorite flags, IDs and snapshots without accepting paths", () => {
    const id = "a".repeat(64);
    expect(parseFavoriteFlag(false)).toBe(false);
    for (const value of [1, "true", null, {}]) expect(() => parseFavoriteFlag(value)).toThrow();
    expect(parseFavoriteSnapshot({ directory: "D:\\Test", fileIds: [id] }).fileIds).toEqual([id]);
    for (const fileIds of [["D:\\secret.png"], [id, id]]) expect(() => parseFavoriteSnapshot({ directory: "D:\\Test", fileIds })).toThrow();
    expect(() => parseFavoriteSnapshot({ directory: null, fileIds: [id] })).toThrow();
    expect(parseFavoriteResult({ ok: true, code: null, message: "已收藏", fileId: id, favorite: true }).favorite).toBe(true);
    expect(() => parseFavoriteResult({ ok: true, code: null, message: "", fileId: "../secret", favorite: true })).toThrow();
  });
  it("accepts only destination modes, never renderer-supplied paths, and validates stored roots", () => {
    for (const mode of ["categorized", "choose-root", "same-location"]) expect(parseOrganizationDestinationMode(mode)).toBe(mode);
    for (const value of ["D:\\outside", {}, null, "../outside"]) expect(() => parseOrganizationDestinationMode(value)).toThrow();
    expect(parseOrganizationRoot("D:\\Library")).toBe("D:\\Library");
    expect(parseOrganizationRoot(null)).toBeNull();
    expect(() => parseOrganizationRoot("../outside")).toThrow();
  });
  it("rejects arbitrary preview paths and malformed identifiers", () => {
    expect(() => parseFileId("D:\\outside\\secret.png")).toThrow("Invalid file identifier");
    expect(parseFileId("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects malformed snapshots and non-image preview payloads", () => {
    expect(() => parseFileSnapshot({ reason: "watch", state: {}, files: [] })).toThrow();
    expect(() => parseThumbnail("file:///outside.png")).toThrow();
    expect(parseThumbnail("data:image/png;base64,AA==")).toContain("data:image/png");
  });

  it("validates narrow action and text-preview payloads", () => {
    expect(parseFileActionResult({ ok: true, message: "已复制文件路径", code: null }).ok).toBe(true);
    expect(() => parseFileActionResult({ ok: true, message: 3, code: null })).toThrow();
    expect(parseTextPreview({ text: "safe <script>", truncated: false })?.text).toContain("<script>");
    expect(() => parseTextPreview({ text: "unsafe" })).toThrow();
    expect(registeredFileUrl("a".repeat(64))).toBe(`sorttie-file://preview/${"a".repeat(64)}`);
  });

  it("validates bounded local AI suggestions and never accepts paths as file IDs", () => {
    const fileId = "a".repeat(64);
    expect(parseLocalAiClassificationResult({
      status: "ready",
      fileId,
      model: "gemma4:e4b",
      category: "文档",
      confidence: 0.82,
      tags: ["说明书"],
      reason: "文件名和文本片段表明它是一份说明文档。",
      usedTextContent: true,
    }).status).toBe("ready");
    expect(parseLocalAiClassificationResult({
      status: "unavailable",
      fileId,
      model: null,
      code: "ollama_unavailable",
      message: "本地模型未运行。",
    }).status).toBe("unavailable");
    expect(() => parseLocalAiClassificationResult({
      status: "ready",
      fileId: "D:\\outside\\secret.txt",
      model: "gemma4:e4b",
      category: "文档",
      confidence: 1.2,
      tags: [],
      reason: "invalid",
      usedTextContent: false,
    })).toThrow();
  });

  it("requires stable identifiers on records crossing the IPC boundary", () => {
    expect(() => parseFileRecord({
      id: "row-0",
      name: "unsafe.txt",
      extension: ".txt",
      absolutePath: "D:\\watched\\unsafe.txt",
      parentDirectory: "D:\\watched",
      sizeBytes: 1,
      createdAt: null,
      modifiedAt: "2026-09-03T00:00:00.000Z",
      firstDiscoveredAt: "2026-09-03T00:00:00.000Z",
      discoveredAt: Date.parse("2026-09-03T00:00:00.000Z"),
      lastActivityAt: Date.parse("2026-09-03T00:00:00.000Z"),
      lastActivityKind: "observed",
      category: "文档",
      kind: "document",
      previewCapability: "text",
      status: "ready",
      isOrganizable: true,
      unavailableReason: null,
    })).toThrow("Invalid file identifier");
  });

  it("validates organization operation identifiers and result payloads", () => {
    const operationId = "op_11111111-1111-4111-8111-111111111111";
    const planId = "plan_11111111-1111-4111-8111-111111111111";
    const fileId = "a".repeat(64);
    expect(parseOperationId(operationId)).toBe(operationId);
    expect(() => parseOperationId("D:\\outside\\file.txt")).toThrow("Invalid operation identifier");
    expect(parseOrganizationPlanRequest([{ fileId, category: "文档" }])).toEqual([{ fileId, category: "文档" }]);
    expect(() => parseOrganizationPlanRequest([{ fileId, category: "文档" }, { fileId, category: "图片" }])).toThrow("Duplicate file");
    expect(parseOrganizationPreparationResult({
      status: "prepared",
      planId,
      destinationDirectory: "D:\\Library",
      items: [{ fileId, operationId, destinationPath: "D:\\Library\\file.txt" }],
      code: null,
      message: "整理位置已确认。",
    }).items[0].operationId).toBe(operationId);
    expect(() => parseOrganizationPreparationResult({
      status: "prepared",
      planId: null,
      destinationDirectory: null,
      items: [],
      code: null,
      message: "invalid",
    })).toThrow();
    expect(parseOrganizationActionResult({
      status: "moved",
      operationId,
      code: null,
      message: "整理完成",
    }).status).toBe("moved");
    expect(() => parseOrganizationActionResult({
      status: "moved",
      operationId: "source.txt",
      code: null,
      message: "invalid",
    })).toThrow();
  });
});
