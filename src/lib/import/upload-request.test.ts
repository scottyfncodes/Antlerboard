import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, readJsonResponse, uploadSizeError } from "./upload-request";

describe("uploadSizeError", () => {
  it("allows the real import files (workbook + auction file + .csv.gz)", () => {
    expect(uploadSizeError([{ size: 468_625 }, { size: 128_233 }, { size: 305_705 }])).toBeNull();
  });

  it("allows exactly the limit", () => {
    expect(uploadSizeError([{ size: MAX_UPLOAD_BYTES }])).toBeNull();
  });

  it("rejects the uncompressed transaction .csv with a size and a fix", () => {
    const msg = uploadSizeError([{ size: 468_625 }, { size: 128_233 }, { size: 4_566_642 }]);
    expect(msg).toContain("5.2 MB");
    expect(msg).toContain("4.4 MB");
    expect(msg).toContain(".csv.gz");
  });
});

describe("readJsonResponse", () => {
  it("returns the data of a normal JSON response", async () => {
    const res = new Response(JSON.stringify({ previewToken: "t", summary: { players: 1291 } }), { status: 200 });
    expect(await readJsonResponse(res, "fallback")).toEqual({ ok: true, data: { previewToken: "t", summary: { players: 1291 } } });
  });

  it("turns Vercel's plain-text 413 into a readable error instead of throwing", async () => {
    const res = new Response("Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n", { status: 413, headers: { "Content-Type": "text/plain" } });
    const out = await readJsonResponse(res, "Could not build the preview.");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("too large");
    expect(!out.ok && out.error).toContain(".csv.gz");
  });

  it("keeps the route's own error message", async () => {
    const res = new Response(JSON.stringify({ error: "All three files are required." }), { status: 400 });
    expect(await readJsonResponse(res, "fallback")).toEqual({ ok: false, error: "All three files are required.", data: { error: "All three files are required." } });
  });

  it("passes error details such as commit conflicts through", async () => {
    const res = new Response(JSON.stringify({ conflicts: ["Transaction 469.l.8891.tr.5 already synced."] }), { status: 409 });
    const out = await readJsonResponse(res, "Import failed.");
    expect(out).toEqual({ ok: false, error: "Import failed.", data: { conflicts: ["Transaction 469.l.8891.tr.5 already synced."] } });
  });

  it("does not throw on a non-JSON error page", async () => {
    const res = new Response("<html>504 Gateway Timeout</html>", { status: 504 });
    const out = await readJsonResponse(res, "Could not build the preview.");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toBe("Could not build the preview. The server answered 504 without details - try again.");
  });
});
