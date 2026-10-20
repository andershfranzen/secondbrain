import { describe, it, expect } from "vitest";
import {
  chunks,
  slice,
  assertEvidence,
  operationId,
  randomUUID,
  config,
} from "@secondbrain/shared";
describe("evidence, chunking and configuration", () => {
  it("retains all 100,000 Unicode code points across overlapping chunks", () => {
    const text = "🌱æøå Think about the server. ".repeat(4000),
      parts = chunks(text);
    expect(parts[0]!.start).toBe(0);
    expect(parts.at(-1)!.end).toBe([...text].length);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      expect(p.content).toBe(slice(text, p.start, p.end));
      if (i) expect(p.start).toBeLessThan(parts[i - 1]!.end);
    }
  });
  it("produces stable valid operation UUIDs", () => {
    expect(operationId("same-input")).toBe(operationId("same-input"));
    expect(operationId("same-input")).not.toBe(operationId("other"));
    expect(operationId("same-input")).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/,
    );
  });
});
