// @vitest-environment jsdom
import { act, createElement } from "react";
import { createTestRoot } from "./testing/react-root.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSummary, MonitorMetrics } from "@uptime/contracts";
import { regions } from "@uptime/regions";
import { chooseOption } from "./select-test-helpers.js";

import { api } from "./api.js";
import { clearRowMetricsCache, MonitorList } from "./monitor-list.js";

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
  vi.spyOn(api, "monitorMetrics").mockResolvedValue({});
});

afterEach(() => { vi.restoreAllMocks(); });

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

describe("board header sorting", () => {
  it("sorts from the visible headers and reverses a selected column", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const slow = summary("00000000-0000-4000-8000-000000000021", "Zulu");
    const fast = summary("00000000-0000-4000-8000-000000000022", "Alpha");
    fast.monitor.intervalSeconds = 60;
    fast.monitor.regionIds = ["us-east", "eu-west"];
    fast.targetChecksPerDay = 2_880;
    const view = createTestRoot();

    await act(async () => {
      view.root.render(createElement(MonitorList, { items: [slow, fast], onChanged: () => undefined }));
    });

    const header = view.container.querySelector(".ut-board__head")!;
    const firstName = () => view.container.querySelector(".monitor-row strong")?.textContent;
    const sortButton = (label: string) => [...header.querySelectorAll("button")].find(
      (button) => button.textContent?.trim().startsWith(label),
    );

    expect(view.container.querySelector(".monitor-sort")).toBeNull();
    expect(sortButton("Status")?.textContent).toContain("sorted ascending");
    expect([...header.querySelectorAll("button")]).toHaveLength(5);
    expect(view.container.querySelector(".ut-monitor__frequency")?.textContent).toBeTruthy();
    expect(view.container.querySelector(".ut-monitor__requests")?.textContent).toBeTruthy();

    await act(async () => sortButton("Frequency")?.click());
    expect(firstName()).toBe("Alpha");
    expect(sortButton("Frequency")?.textContent).toContain("sorted ascending");

    await act(async () => sortButton("Frequency")?.click());
    expect(firstName()).toBe("Zulu");
    expect(sortButton("Frequency")?.textContent).toContain("sorted descending");

    await act(async () => sortButton("Requests/day")?.click());
    expect(firstName()).toBe("Zulu");
    await act(async () => sortButton("Regions")?.click());
    expect(firstName()).toBe("Zulu");
    await act(async () => sortButton("Monitor")?.click());
    expect(firstName()).toBe("Alpha");

    await view.cleanup();
    vi.unstubAllGlobals();
  });
});

describe("real fetched metrics", () => {
  it("fetches metrics once for multiple rows and renders uptime, p50, and seven day bars", async () => {
    const days = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      uptimePercentage: 100,
      averageResponseMs: 55,
    }));
    const metrics = {
      [items[0]!.monitor.id]: { days, uptime24h: 99, p50Ms: 55.4 },
      [items[1]!.monitor.id]: { days, uptime24h: null, p50Ms: null },
    };
    const metricsSpy = vi.spyOn(api, "monitorMetrics").mockResolvedValue(metrics);
    const badgesSpy = vi.spyOn(api, "badges").mockResolvedValue({ badges: [] });
    const view = createTestRoot();

    await act(async () => {
      view.root.render(createElement(MonitorList, { items, onChanged: () => undefined }));
    });

    expect(metricsSpy).toHaveBeenCalledExactlyOnceWith();
    const rows = view.container.querySelectorAll(".monitor-row");
    expect(rows[0]!.textContent).toContain("99%");
    expect(rows[0]!.textContent).toContain("55 ms");
    expect(rows[1]!.querySelector('[aria-label="Aggregate p50 is unavailable"]')?.getAttribute("title"))
      .toBe("Aggregate p50 is unavailable");
    for (const row of rows) expect(row.querySelectorAll(".ut-day")).toHaveLength(7);

    // A refreshed list with unchanged observations reuses the cached bulk response.
    await act(async () => {
      view.root.render(createElement(MonitorList, { items: [...items], onChanged: () => undefined }));
    });
    expect(metricsSpy).toHaveBeenCalledOnce();

    await view.cleanup();
    metricsSpy.mockRestore();
    badgesSpy.mockRestore();
  });

  it("refreshes the bulk metrics after the cache expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const metricsSpy = vi.spyOn(api, "monitorMetrics").mockResolvedValue({});
    const badgesSpy = vi.spyOn(api, "badges").mockResolvedValue({ badges: [] });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MonitorList, { items, onChanged: () => undefined }));
    });
    clock.mockReturnValue(61_001);
    await act(async () => {
      view.root.render(createElement(MonitorList, { items: [...items], onChanged: () => undefined }));
    });
    expect(metricsSpy).toHaveBeenCalledTimes(2);
    await view.cleanup();
    clock.mockRestore();
    metricsSpy.mockRestore();
    badgesSpy.mockRestore();
  });

  it("ignores a metrics response after the list unmounts", async () => {
    let resolveMetrics!: (metrics: Record<string, MonitorMetrics>) => void;
    const metricsSpy = vi.spyOn(api, "monitorMetrics").mockImplementation(
      () => new Promise((resolve) => { resolveMetrics = resolve; }),
    );
    const badgesSpy = vi.spyOn(api, "badges").mockResolvedValue({ badges: [] });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MonitorList, { items, onChanged: () => undefined }));
    });
    await act(async () => { view.root.render(createElement("div", null, "Empty")); });
    await act(async () => {
      resolveMetrics({ [items[0]!.monitor.id]: { days: [], uptime24h: 100, p50Ms: 55 } });
    });
    expect(view.container.textContent).toBe("Empty");
    await view.cleanup();
    metricsSpy.mockRestore();
    badgesSpy.mockRestore();
  });
});
