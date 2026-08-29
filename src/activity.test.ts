import { describe, expect, it, vi } from "vitest";
import { activitySourceDomains, COMPLETED_DELETE_CONFIRMATION, confirmItemDeletion, downloadTime, formatElapsed } from "./activity.js";

describe("activity source filters", () => {
  it("aggregates sources by case-insensitive domain", () => {
    expect(activitySourceDomains([
      { domain: "OnlyFans.com" }, { domain: "onlyfans.com" }, { domain: " x.com " }, { domain: "" }, { domain: "x.com" },
    ])).toEqual(["onlyfans.com", "x.com"]);
  });
});

describe("activity download timing", () => {
  it("formats short, minute, and hour durations", () => {
    expect(formatElapsed(500)).toBe("<1s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });

  it("uses the persisted finish time for completed downloads", () => {
    expect(downloadTime({
      status: "completed",
      downloadStartedAt: "2026-08-25T12:00:00.000Z",
      downloadFinishedAt: "2026-08-25T12:02:05.000Z",
    })).toBe("2m 5s");
  });

  it("shows live elapsed time only while a download is running", () => {
    expect(downloadTime({ status: "downloading", downloadStartedAt: "2026-08-25T12:00:00.000Z" }, Date.parse("2026-08-25T12:00:08.000Z"))).toBe("8s");
    expect(downloadTime({ status: "queued", downloadStartedAt: "2026-08-25T12:00:00.000Z" })).toBe("—");
    expect(downloadTime({ status: "completed" })).toBe("—");
  });
});

describe("completed recording deletion", () => {
  it("requires explicit confirmation only when the media file will also be deleted", () => {
    const confirm = vi.fn(() => false);
    expect(confirmItemDeletion("completed", confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(COMPLETED_DELETE_CONFIRMATION);
    confirm.mockClear();
    expect(confirmItemDeletion("failed", confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
