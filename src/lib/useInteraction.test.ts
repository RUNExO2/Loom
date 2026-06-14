import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useInteraction } from "./useInteraction";

describe("useInteraction", () => {
  it("runs idle → loading → success → idle", async () => {
    const { result } = renderHook(() => useInteraction({ successMs: 40 }));
    expect(result.current.state).toBe("idle");

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let rp: Promise<unknown> | undefined;
    act(() => { rp = result.current.run(() => gate); });
    expect(result.current.state).toBe("loading");
    expect(result.current.isLoading).toBe(true);

    await act(async () => { release(); await rp; });
    expect(result.current.state).toBe("success");

    await waitFor(() => expect(result.current.state).toBe("idle"));
  });

  it("captures the error message then returns to idle", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useInteraction({ errorMs: 40 }));

    await act(async () => { await result.current.run(async () => { throw new Error("boom"); }); });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("boom");

    await waitFor(() => expect(result.current.state).toBe("idle"));
    spy.mockRestore();
  });

  it("ignores re-entrant runs while one is in flight", async () => {
    const { result } = renderHook(() => useInteraction({ successMs: 10 }));
    const fn = vi.fn(() => new Promise<void>((r) => setTimeout(r, 20)));

    let first: Promise<unknown> | undefined;
    act(() => { first = result.current.run(fn); });
    act(() => { result.current.run(fn); }); // dropped — still loading
    await act(async () => { await first; });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
