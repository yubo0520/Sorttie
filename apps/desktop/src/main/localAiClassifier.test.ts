// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { LocalAiClassifier, type LocalAiFileInput } from "./localAiClassifier";

const input: LocalAiFileInput = {
  fileId: "a".repeat(64),
  name: "会议记录.mystery",
  extension: ".mystery",
  directoryName: "Downloads",
  sizeBytes: 128,
  textContent: "讨论发布计划与验收时间。",
};

function ollamaResponse(content: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LocalAiClassifier", () => {
  it("requests structured, non-thinking local classification and validates the result", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gemma4:e4b");
      expect(body.stream).toBe(false);
      expect(body.think).toBe(false);
      expect(body.options.temperature).toBe(0);
      expect(body.format.properties.category.enum).toContain("代码与数据");
      expect(body.messages[1].content).toContain("会议记录.mystery");
      expect(init?.redirect).toBe("error");
      return ollamaResponse({ category: "文档", confidence: 0.8, tags: ["会议"], reason: "文本片段呈现会议记录内容。" });
    });
    const result = await new LocalAiClassifier(request).classify(input);
    expect(result).toMatchObject({ status: "ready", fileId: input.fileId, model: "gemma4:e4b", category: "文档", usedTextContent: true });
  });

  it("falls back to the small local model only when the preferred model is missing", async () => {
    const models: string[] = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      models.push(model);
      return model === "gemma4:e4b"
        ? new Response(JSON.stringify({ error: "model not found" }), { status: 404 })
        : ollamaResponse({ category: "其他", confidence: 0.4, tags: ["未知"], reason: "现有信息不足以可靠分类。" });
    });
    const result = await new LocalAiClassifier(request).classify({ ...input, textContent: null });
    expect(models).toEqual(["gemma4:e4b", "gemma3:1b"]);
    expect(result).toMatchObject({ status: "ready", model: "gemma3:1b", category: "其他", usedTextContent: false });
  });

  it("returns safe structured failures for an unavailable runtime or invalid model output", async () => {
    const unavailable = await new LocalAiClassifier(vi.fn(async () => { throw new TypeError("fetch failed"); })).classify(input);
    expect(unavailable).toMatchObject({ status: "unavailable", code: "ollama_unavailable", model: null });

    const invalid = await new LocalAiClassifier(vi.fn(async () => ollamaResponse({ category: "随便", reason: "bad" }))).classify(input);
    expect(invalid).toMatchObject({ status: "failed", code: "invalid_model_output", model: "gemma4:e4b" });
  });
});
