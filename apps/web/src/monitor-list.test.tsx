// @vitest-environment jsdom
import { act, createElement } from "react";
import { createTestRoot } from "./testing/react-root.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSummary } from "@uptime/contracts";
import { regions } from "@uptime/regions";
import { chooseOption } from "./select-test-helpers.js";

import { api, type MonitorDetailResponse } from "./api.js";
import { clearRowMetricsCache, extractUptime24h, MonitorList } from "./monitor-list.js";

function summary(id: string, name: string): MonitorSummary {
  return {
    monitor: {
      id,
      name,
      url: `https://${name.toLowerCase()}.example.test`,
      regionIds: ["us-east"],
      intervalSeconds: 300,
      timeoutMs: 10_000,
      enabled: true,
      dnsDiagnosticsEnabled: false,
      isPublic: false,
      publicSlug: null,
      createdAt: "2026-09-03T10:00:00.000Z",
      updatedAt: "2026-09-03T10:00:00.000Z",
    },
    status: "up",
    latestByRegion: {
      "us-east": null,
      "us-west": null,
      "eu-west": null,
      "eu-north": null,
      "eu-south": null,
      asia: null,
      "asia-east": null,
      "asia-south": null,
      "canada-central": null,
    },
    targetChecksPerDay: 288,
  };
}

const bravo = summary("00000000-0000-4000-8000-000000000002", "Bravo");
const items: MonitorSummary[] = [
  summary("00000000-0000-4000-8000-000000000001", "Alpha"),
  {
    ...bravo,
    monitor: {
      ...bravo.monitor,
      regionIds: ["eu-west"],
      badge: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "API",
        color: "#2563eb",
      },
    },
  },
];

beforeEach(() => {
  clearRowMetricsCache();
});

describe("bulk monitor editing", () => {
  it("updates the frequency for the selected monitors", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ badges: [], updatedCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    const { container, root, cleanup } = createTestRoot();

    await act(async () => root.render(createElement(MonitorList, { items, onChanged: changed })));
    const buttons = [...container.querySelectorAll("button")];
    await act(async () =>
      buttons.find((button) => button.textContent === "Edit multiple")?.click(),
    );
    const selectAll = container.querySelector<HTMLInputElement>(
      ".bulk-monitor-editor__select-all input",
    )!;
    await act(async () => selectAll.click());
    await chooseOption(
      container.querySelector(".bulk-monitor-editor__frequency button.ut-select")!,
      "Every 20 min",
    );
    const apply = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Apply to"),
    )!;
    await act(async () => apply.click());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/monitors/bulk-frequency",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          monitorIds: items.map((item) => item.monitor.id),
          intervalSeconds: 1_200,
        }),
      }),
    );
    expect(changed).toHaveBeenCalledOnce();

    await cleanup();
    vi.unstubAllGlobals();
  });

  it("selects the visible range between checked monitors with shift-click", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { container, root, cleanup } = createTestRoot();
    const rangeItems = [
      summary("00000000-0000-4000-8000-000000000011", "Alpha"),
      summary("00000000-0000-4000-8000-000000000012", "Bravo"),
      summary("00000000-0000-4000-8000-000000000013", "Charlie"),
    ];

    await act(async () => {
      root.render(createElement(MonitorList, { items: rangeItems, onChanged: () => undefined }));
      await Promise.resolve();
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Edit multiple")
        ?.click(),
    );
    const checkboxes = container.querySelectorAll<HTMLInputElement>(".monitor-row__select");
    await act(async () => checkboxes[0]!.click());
    await act(async () =>
      checkboxes[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
    );

    expect([...checkboxes].map((checkbox) => checkbox.checked)).toEqual([true, true, true]);

    await cleanup();
    vi.unstubAllGlobals();
  });
});

describe("monitor filtering", () => {
  it("filters by name, badge, and region", async () => {
    // A fresh Response per call: row metrics share this mock and would drain a single body.
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ badges: [items[1]!.monitor.badge] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(MonitorList, { items, onChanged: () => undefined }));
      // Let the badge list resolve so the badge filter has options to choose from.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const name = container.querySelector<HTMLInputElement>(".monitor-filters input")!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setInputValue?.call(name, "bravo");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".monitor-row")).toHaveLength(1);

    await act(async () => {
      setInputValue?.call(name, "");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const filters = container.querySelectorAll(".monitor-filters button.ut-select");
    await chooseOption(filters[0]!, items[1]!.monitor.badge!.name);
    await chooseOption(filters[1]!, regions.find((region) => region.id === "eu-west")!.label);
    expect(container.querySelectorAll(".monitor-row")).toHaveLength(1);
    expect(container.querySelector(".monitor-row strong")?.textContent).toBe("Bravo");

    await cleanup();
    vi.unstubAllGlobals();
  });
});

describe("real fetched metrics", () => {
  it("extracts 24h uptime accurately from stats sample counts without guessing", () => {
    const detail: MonitorDetailResponse = {
      summary: summary("00000000-0000-4000-8000-000000000099", "MetricTest"),
      latency: {
        points: [],
        aggregatePoints: [],
        stats: [
          {
            regionId: "us-east",
            sampleCount: 100,
            successCount: 99,
            p50Ms: 42,
            p95Ms: 50,
            p99Ms: 60,
          },
        ],
        aggregateStats: {
          averageResponseMs: 42,
          maximumResponseMs: 50,
          maximumResponseRegionId: "us-east",
          minimumResponseMs: 40,
        },
      },
      uptime: {
        uptimePercentage: 50,
        status: "up",
        days: [
          {
            date: "2026-09-02",
            uptimePercentage: 20,
            averageResponseMs: 100,
          },
        ],
      },
    };

    expect(extractUptime24h(detail)).toBe(99);

    const zeroSampleDetail: MonitorDetailResponse = {
      ...detail,
      latency: {
        ...detail.latency,
        stats: [
          {
            regionId: "us-east",
            sampleCount: 0,
            successCount: 0,
            p50Ms: null,
            p95Ms: null,
            p99Ms: null,
          },
        ],
      },
    };
    expect(extractUptime24h(zeroSampleDetail)).toBeNull();
  });

  it("renders real 24h uptime counts (99/100 gives 99%) and marks aggregate p50 as unavailable even with regional p50 and latest response", async () => {
    const testItem = summary("00000000-0000-4000-8000-000000000099", "MetricTest");
    testItem.latestByRegion["us-east"] = {
      id: "obs-1",
      checkRunId: "run-1",
      monitorId: testItem.monitor.id,
      regionId: "us-east",
      status: "success",
      success: true,
      httpStatus: 200,
      responseMs: 999,
      totalMs: 999,
      errorCode: null,
      errorDetail: null,
      placement: null,
      colo: null,
      finalUrl: null,
      endpointEvidence: null,
      dnsDiagnostic: null,
      redirectCount: 0,
      bodyBytes: null,
      probeVersion: null,
      startedAt: "2026-09-03T10:00:00.000Z",
      completedAt: "2026-09-03T10:00:00.999Z",
    };

    const mockDetail: MonitorDetailResponse = {
      summary: testItem,
      latency: {
        points: [],
        aggregatePoints: [
          { observedAt: "2026-09-03T09:00:00.000Z", responseMs: 42, success: true },
        ],
        stats: [
          {
            regionId: "us-east",
            sampleCount: 100,
            successCount: 99,
            p50Ms: 42,
            p95Ms: 50,
            p99Ms: 60,
          },
        ],
        aggregateStats: {
          averageResponseMs: 42,
          maximumResponseMs: 50,
          maximumResponseRegionId: "us-east",
          minimumResponseMs: 40,
        },
      },
      uptime: {
        uptimePercentage: 99,
        status: "up",
        days: Array.from({ length: 30 }, (_, index) => ({
          date: `2026-08-${String(index + 1).padStart(2, "0")}`,
          uptimePercentage: 100,
          averageResponseMs: 42,
        })),
      },
    };

    const monitorSpy = vi.spyOn(api, "monitor").mockResolvedValue(mockDetail);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(MonitorList, { items: [testItem], onChanged: () => undefined }));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(monitorSpy).toHaveBeenCalledWith(testItem.monitor.id, "24h");
    expect(container.textContent).toContain("99%");
    expect(container.textContent).not.toContain("42 ms");
    expect(container.textContent).not.toContain("999 ms");

    const unavailableP50 = container.querySelector('[aria-label="Aggregate p50 is unavailable"]');
    expect(unavailableP50).not.toBeNull();
    expect(unavailableP50?.getAttribute("title")).toBe("Aggregate p50 is unavailable");
    expect(unavailableP50?.textContent).toBe("—");

    expect(container.querySelectorAll(".ut-day")).toHaveLength(30);

    monitorSpy.mockRestore();
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("defers fetching off-screen monitors until intersecting near viewport when IntersectionObserver is supported", async () => {
    let observerCallback: IntersectionObserverCallback | null = null;
    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "200px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observeSpy;
      unobserve = vi.fn();
      disconnect = disconnectSpy;
      takeRecords = () => [];
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const testItem = summary("00000000-0000-4000-8000-000000000088", "OffScreenTest");
    const mockDetail: MonitorDetailResponse = {
      summary: testItem,
      latency: {
        points: [],
        aggregatePoints: [],
        stats: [{ regionId: "us-east", sampleCount: 10, successCount: 10, p50Ms: null, p95Ms: null, p99Ms: null }],
        aggregateStats: {
          averageResponseMs: 15,
          maximumResponseMs: 20,
          maximumResponseRegionId: "us-east",
          minimumResponseMs: 10,
        },
      },
      uptime: {
        uptimePercentage: 100,
        status: "up",
        days: [],
      },
    };

    const monitorSpy = vi.spyOn(api, "monitor").mockResolvedValue(mockDetail);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(MonitorList, { items: [testItem], onChanged: () => undefined }));
    });

    expect(observeSpy).toHaveBeenCalled();
    expect(monitorSpy).not.toHaveBeenCalled();

    const row = container.querySelector(".monitor-row-shell")!;
    await act(async () => {
      observerCallback?.(
        [
          {
            isIntersecting: true,
            target: row,
            intersectionRatio: 1,
            boundingClientRect: row.getBoundingClientRect(),
            intersectionRect: row.getBoundingClientRect(),
            rootBounds: null,
            time: Date.now(),
          },
        ],
        {} as IntersectionObserver,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(monitorSpy).toHaveBeenCalledWith(testItem.monitor.id, "24h");
    expect(disconnectSpy).toHaveBeenCalled();

    monitorSpy.mockRestore();
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("aborts in-flight fetches on unmount or filter without leaking slots or setting stale state", async () => {
    let pendingResolve: ((res: MonitorDetailResponse) => void) | null = null;
    const testItem = summary("00000000-0000-4000-8000-000000000077", "CancelTest");

    const monitorSpy = vi.spyOn(api, "monitor").mockImplementation(
      () =>
        new Promise<MonitorDetailResponse>((resolve) => {
          pendingResolve = resolve;
        }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(MonitorList, { items: [testItem], onChanged: () => undefined }));
    });

    expect(monitorSpy).toHaveBeenCalledWith(testItem.monitor.id, "24h");

    // Unmount while fetch is still in flight
    await act(async () => {
      root.render(createElement("div", null, "Empty"));
    });

    // Resolve the in-flight promise after unmount; should not throw or cause state update errors
    await act(async () => {
      pendingResolve?.({
        summary: testItem,
        latency: {
          points: [],
          aggregatePoints: [],
          stats: [{ regionId: "us-east", sampleCount: 10, successCount: 10, p50Ms: null, p95Ms: null, p99Ms: null }],
          aggregateStats: {
            averageResponseMs: 10,
            maximumResponseMs: 15,
            maximumResponseRegionId: "us-east",
            minimumResponseMs: 5,
          },
        },
        uptime: {
          uptimePercentage: 100,
          status: "up",
          days: [],
        },
      });
      await Promise.resolve();
    });

    expect(container.textContent).toBe("Empty");

    monitorSpy.mockRestore();
    await cleanup();
    vi.unstubAllGlobals();
  });
});
