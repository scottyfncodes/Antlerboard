import { describe, it, expect } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it.each([["/trades?counter=1", "/trades?counter=1"], ["/", "/"]])("keeps the same-site path %s", (input, out) => {
    expect(safeNextPath(input)).toBe(out);
  });

  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])(
    "sends %s home instead",
    (input) => {
      expect(safeNextPath(input)).toBe("/");
    }
  );
});
