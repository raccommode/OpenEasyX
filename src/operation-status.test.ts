import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchOperationStatus } from "./operation-status";

const page = Object.assign(new EventTarget(), { hidden: false });
const idle = { running: false, progress: 0 };
const active = { running: true, progress: 35 };
let watcher: ReturnType<typeof watchOperationStatus>;

function changeVisibility(hidden: boolean) {
  page.hidden = hidden;
  page.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  page.hidden = false;
  vi.stubGlobal("document", page);
});

afterEach(() => {
  watcher.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("header status polling", () => {
  it("slows idle and background polling and checks immediately upon returning to the tab", async () => {
    const get = vi.fn(async () => Response.json(idle));
    vi.stubGlobal("fetch", get);
    watcher = watchOperationStatus("/status", vi.fn());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(get).toHaveBeenCalledTimes(2);
    changeVisibility(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(get).toHaveBeenCalledTimes(3);
    changeVisibility(false);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("checks immediately on local start, monitors progress, displays completion and returns to idle polling", async () => {
    const get = vi.fn(async () => Response.json(idle));
    vi.stubGlobal("fetch", get);
    const update = vi.fn();
    watcher = watchOperationStatus("/status", update);
    await vi.advanceTimersByTimeAsync(100);
    watcher.begin();
    expect(get).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({ running: true, percent: 0 });
    get.mockResolvedValueOnce(Response.json(active));
    await vi.advanceTimersByTimeAsync(400);
    expect(update).toHaveBeenLastCalledWith({ running: true, percent: 35 });
    await vi.advanceTimersByTimeAsync(400);
    expect(update).toHaveBeenLastCalledWith({ running: true, percent: 100 });
    await vi.advanceTimersByTimeAsync(550);
    expect(update).toHaveBeenLastCalledWith({ running: false, percent: 0 });
    await vi.advanceTimersByTimeAsync(500);
    get.mockClear();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(get).not.toHaveBeenCalled();
  });

  it("ignores obsolete responses after a local start or unmount", async () => {
    let resolveRequest!: (response: Response) => void;
    const get = vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal("fetch", get);
    const update = vi.fn();
    watcher = watchOperationStatus("/status", update);
    const resolveInitial = resolveRequest;
    watcher.begin();
    resolveInitial(Response.json(active));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    watcher.dispose();
    resolveRequest(Response.json(active));
    changeVisibility(false);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(get).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
