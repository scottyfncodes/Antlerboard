import { describe, it, expect, afterEach, vi } from "vitest";
import { callApi, sendJson, GENERIC_API_ERROR } from "./call-api";

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("callApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed body on success", async () => {
    stubFetch(async () => Response.json({ details: { id: "d1" } }));
    expect(await callApi("/api/x")).toEqual({ ok: true, data: { details: { id: "d1" } } });
  });

  it("surfaces the server's error message on a 4xx", async () => {
    stubFetch(async () => Response.json({ error: "Bet is already settled" }, { status: 409 }));
    expect(await callApi("/api/x")).toEqual({ ok: false, error: "Bet is already settled" });
  });

  it("falls back to a generic message for a 500 with a non-JSON body", async () => {
    stubFetch(async () => new Response("Internal Server Error", { status: 500 }));
    expect(await callApi("/api/x")).toEqual({ ok: false, error: GENERIC_API_ERROR });
  });

  it("falls back to the caller's message on a network failure", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await callApi("/api/x", undefined, "Could not save.")).toEqual({ ok: false, error: "Could not save." });
  });

  it("sendJson posts a JSON body with the given method", async () => {
    const fn = stubFetch(async () => Response.json({}));
    await sendJson("/api/x", { a: 1 }, "PATCH");
    expect(fn).toHaveBeenCalledWith("/api/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });
});
