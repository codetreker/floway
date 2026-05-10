import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { DashboardPage } from "./dashboard.tsx";

type ChartDataset = {
  _keyId?: string;
  _model?: string;
  label?: string;
  borderColor?: string;
  backgroundColor?: string;
  fill?: string | boolean;
  spanGaps?: boolean;
  data: unknown[];
};

type ChartOptions = {
  plugins?: {
    tooltip?: {
      callbacks?: {
        beforeBody?: (items: unknown[]) => string[] | string;
        label?: (ctx: unknown) => string;
      };
    };
  };
  scales: {
    y: {
      title: { text?: string };
      stacked?: boolean;
      suggestedMax?: number;
    };
  };
};

type ChartConfig = {
  data: { labels?: unknown[]; datasets: ChartDataset[] };
  options: ChartOptions;
};

function expectedTodayChartLabels() {
  const labels = [];
  const cur = new Date();
  cur.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 23; i >= 0; i--) {
    const d = new Date(cur.getTime() - i * 3600000);
    const h = d.getHours();
    labels.push(pad(h) + ":00 \u2013 " + pad((h + 1) % 24) + ":00");
  }
  return labels;
}

function expected4hChartLabels(count: number) {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() - (start.getHours() % 4));
  const labels = [];
  let prevDateKey: string | null = null;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(start.getTime() - i * 4 * 3600000);
    const h = d.getHours();
    if (h % 8 === 0) {
      const dateKey = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" +
        pad(d.getDate());
      const endH = (h + 8) % 24;
      const time = pad(h) + ":00 – " + pad(endH) + ":00";
      const datePrefix = dateKey !== prevDateKey
        ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
          " "
        : "";
      labels.push(datePrefix + time);
      prevDateKey = dateKey;
    } else {
      labels.push("");
    }
  }
  return labels;
}

function extractDashboardScript() {
  const html = DashboardPage().toString();
  const scripts = html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g);
  for (const script of scripts) {
    if (script[1].includes("function dashboardApp()")) return script[1];
  }
  throw new Error("dashboard script not found");
}

function createDashboardHarness(options: { document?: unknown } = {}) {
  const charts: FakeChart[] = [];
  class FakeChart {
    canvas: unknown;
    data: ChartConfig["data"];
    options: ChartConfig["options"];
    visibility = new Map<number, boolean>();
    lastUpdateMode: string | null = null;

    constructor(canvas: unknown, config: ChartConfig) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      charts.push(this);
    }

    stop() {}
    destroy() {}

    setDatasetVisibility(index: number, visible: boolean) {
      this.visibility.set(index, visible);
    }

    update(mode: string) {
      this.lastUpdateMode = mode;
    }
  }

  const localStorage = {
    getItem(key: string) {
      if (key === "authKey") return "test-key";
      if (key === "isAdmin") return "1";
      return null;
    },
    removeItem() {},
  };
  const location = { hash: "#usage", origin: "https://example.test" };
  const window = { addEventListener() {}, location };
  const document = options.document ?? {
    getElementById(id: string) {
      return { id, clientWidth: 640 };
    },
  };

  const dashboardApp = new Function(
    "localStorage",
    "location",
    "window",
    "document",
    "Chart",
    extractDashboardScript() + "\nreturn dashboardApp;",
  )(localStorage, location, window, document, FakeChart);

  return { app: dashboardApp(), charts };
}

function usageRecord(offsetHours: number, overrides: Record<string, unknown>) {
  const date = new Date();
  date.setHours(date.getHours() + offsetHours, 0, 0, 0);
  return {
    hour: date.toISOString().slice(0, 13),
    keyId: "key_1",
    keyName: "Primary",
    model: "model-a",
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
    ...overrides,
  };
}

function searchUsageRecord(
  offsetHours: number,
  overrides: Record<string, unknown>,
) {
  const date = new Date();
  date.setHours(date.getHours() + offsetHours, 0, 0, 0);
  return {
    provider: "tavily",
    hour: date.toISOString().slice(0, 13),
    keyId: "key_1",
    keyName: "Primary",
    requests: 1,
    ...overrides,
  };
}

const TEST_USAGE_KEY_COLOR_ORDER = [
  "46360b74-2457-4a38-a116-7afdb2894632",
  "4969165b-3412-436c-87d9-3fd4770164b5",
  "541128df-ee71-4fc1-9cc7-6855ca1e7fcc",
  "e694733c-370e-4b9a-9331-57eefd12a8cc",
  "5a4481c9-0230-481c-bd17-49fc2bda6f02",
  "future-1",
  "3f2fe5b9-2991-4bb8-bc04-2852f58150ca",
  "future-3",
  "future-2",
  "future-4",
];

Deno.test("DashboardPage renders split dashboard shell", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, 'x-data="dashboardApp()"');
  assertStringIncludes(html, "Copilot Gateway");
  assertStringIncludes(html, "API Keys");
  assertStringIncludes(html, "Total Tokens");
  assertStringIncludes(html, "Performance");
  assertStringIncludes(html, "Cache Hit Rate");
  assertStringIncludes(html, "function dashboardApp()");
});

Deno.test("dashboardApp renders performance model percentile chart", () => {
  const { app, charts } = createDashboardHarness();
  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);
  const previousHour = new Date(currentHour.getTime() - 3600000);

  app.tab = "performance";
  app.performancePercentile = "p95Ms";
  app.performanceSeries = [
    {
      bucket: app.localHourKey(previousHour),
      group: "claude-opus-4-7",
      p95Ms: 300,
    },
    {
      bucket: app.localHourKey(currentHour),
      group: "claude-opus-4-7",
      p95Ms: 600,
    },
  ];

  app.renderPerformanceChart();

  assertEquals(charts.length, 1);
  assertEquals(charts[0].data.datasets[0].label, "claude-opus-4-7");
  assertEquals(charts[0].data.datasets[0].data.filter((v) => v !== null), [
    300,
    600,
  ]);
});

Deno.test("dashboardApp renders performance chart over the full hourly range", () => {
  const { app, charts } = createDashboardHarness();
  const now = new Date();
  now.setMinutes(0, 0, 0);

  app.tab = "performance";
  app.performanceRange = "today";
  app.performancePercentile = "p95Ms";
  app.performanceSeries = [
    { bucket: app.localHourKey(now), group: "claude-opus-4-7", p95Ms: 600 },
  ];

  app.renderPerformanceChart();

  assertEquals(charts[0].data.labels, expectedTodayChartLabels());
  assertEquals(charts[0].data.datasets[0].data.length, 24);
  assertEquals(charts[0].data.datasets[0].data.at(-1), 600);
});

Deno.test("dashboardApp renders performance chart with 4h buckets for 7d range", () => {
  const { app, charts } = createDashboardHarness();
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() - (start.getHours() % 4));

  app.tab = "performance";
  app.performanceRange = "7d";
  app.performancePercentile = "p95Ms";
  app.performanceSeries = [
    { bucket: app.local4hBucketKey(start), group: "claude-opus-4-7", p95Ms: 600 },
  ];

  app.renderPerformanceChart();

  assertEquals(charts[0].data.labels, expected4hChartLabels(42));
  assertEquals(charts[0].data.datasets[0].data.length, 42);
  assertEquals(charts[0].data.datasets[0].data.at(-1), 600);
});

Deno.test("dashboardApp renders performance percentile comparison chart", () => {
  const { app, charts } = createDashboardHarness();
  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);
  const previousHour = new Date(currentHour.getTime() - 3600000);

  app.tab = "performance";
  app.performanceChartView = "percentile";
  app.performanceModel = "claude-opus-4-7";
  app.performanceSeries = [
    {
      bucket: app.localHourKey(previousHour),
      group: "claude-opus-4-7",
      p50Ms: 100,
      p95Ms: 300,
      p99Ms: 900,
    },
    {
      bucket: app.localHourKey(currentHour),
      group: "claude-opus-4-7",
      p50Ms: 120,
      p95Ms: 360,
      p99Ms: 1200,
    },
    {
      bucket: app.localHourKey(previousHour),
      group: "gpt-5",
      p50Ms: 30,
      p95Ms: 60,
      p99Ms: 90,
    },
  ];

  app.renderPerformanceChart();

  assertEquals(charts.length, 1);
  assertEquals(charts[0].data.datasets.map((dataset) => dataset.label), [
    "p50",
    "p95",
    "p99",
  ]);
  assertEquals(charts[0].data.datasets[1].data.filter((v) => v !== null), [
    300,
    360,
  ]);
});

Deno.test("DashboardPage renders performance model selector for percentile view", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "performanceChartView === 'percentile'");
  assertStringIncludes(html, 'x-model="performanceModel"');
  assertStringIncludes(html, "performanceModelOptions()");
});

Deno.test("DashboardPage renders performance chart view switcher", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "By Model");
  assertStringIncludes(html, "By Percentile");
});

Deno.test("DashboardPage loads performance dashboard aggregates in one request", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "'/api/performance/overview?'");
  assertFalse(html.includes("this.fetchPerformanceRecords('runtimeLocation'"));
});

Deno.test("DashboardPage renders the search section below the usage cards without architecture labels", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "Search Provider");
  assertStringIncludes(html, "Tavily");
  assertStringIncludes(html, "Microsoft Grounding");
  assertStringIncludes(html, "Save Search Config");
  assertStringIncludes(html, "Test Search");
  assertStringIncludes(html, 'autocomplete="off"');
  assertStringIncludes(
    html,
    ":disabled=\"!searchConfigLoaded || searchConfigTesting || searchConfigDraft.provider === 'disabled'\"",
  );
  assertFalse(html.includes("Control Plane"));
  assertFalse(html.includes("Data Plane"));
  assertFalse(
    html.indexOf("Search Provider") < html.indexOf("Premium Requests"),
  );
});

Deno.test("DashboardPage gates search config controls until saved config has loaded", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, '<template x-if="!searchConfigLoaded">');
  assertStringIncludes(html, '<template x-if="searchConfigLoaded">');
  assertStringIncludes(html, "Loading saved search config...");

  assert(
    html.indexOf('<template x-if="searchConfigLoaded">') <
      html.indexOf("Search Provider"),
  );
  assert(
    html.indexOf("Loading saved search config...") <
      html.indexOf('<template x-if="searchConfigLoaded">'),
  );
});

Deno.test("DashboardPage renders helper functions inside script without HTML entity encoding", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "const draftFromSearchConfig = ");
  assertStringIncludes(html, "const activeCredentialValue = ");
  assertStringIncludes(html, "const setActiveCredentialValue = ");
  assertStringIncludes(html, "const searchConfigFromDraft = ");
  assertFalse(html.includes("=&gt;"));
  assertFalse(html.includes("&quot;tavily&quot;"));
});

Deno.test("DashboardPage no longer ships pricing regexes to the client", () => {
  const html = DashboardPage().toString();

  // Pricing now lives in src/lib/model-pricing.ts and is applied server-side
  // before /api/token-usage returns records, so no MODEL_PRICING table or
  // model-name regex should appear in the rendered dashboard script.
  assertFalse(html.includes("MODEL_PRICING"));
  assertFalse(html.includes("getModelPricing"));
  assertFalse(html.includes("usageModelName"));
});

Deno.test("DashboardPage renders clickable usage summary metrics for chart axis selection", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "tokenChartMetric: 'total'");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('requests')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('cost')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('total')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('input')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('output')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('cached')\"");
  assertStringIncludes(
    html,
    "@click=\"switchTokenChartMetric('cachedRate')\"",
  );
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('prefill')\"");
  assertStringIncludes(
    html,
    "@click=\"switchTokenChartMetric('cacheCreation')\"",
  );
  assertStringIncludes(
    html,
    "@click=\"switchTokenChartMetric('cacheHitRate')\"",
  );
  assertStringIncludes(html, "Cached Input");
  assertStringIncludes(html, "Cached Rate");
  assertStringIncludes(html, "Prefill Input");
  assertStringIncludes(html, "Est. Cost");
  assertFalse(html.includes("Prefill Rate"));
  assertStringIncludes(
    html,
    "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4",
  );
  assertEquals(
    html.split('class="grid grid-cols-2 lg:grid-cols-1 gap-2"').length - 1,
    5,
  );
  assertFalse(html.includes("grid grid-cols-2 md:grid-cols-5 gap-4"));
  assert(html.indexOf("Prefill Input") < html.indexOf("Cached Input"));
  assertStringIncludes(html, ":class=\"tokenChartMetric === 'total'");
});

Deno.test("DashboardPage renders cache and prefill tooltip columns without ratio", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "Cost'.padStart(9)");
  assertStringIncludes(html, "Cached%'.padStart(8)");
  assertFalse(html.includes("Prefill%'.padStart(8)"));
  assertStringIncludes(html, "Output'.padStart(7)");
  assertStringIncludes(html, "Hit%'.padStart(7)");
  assertFalse(html.includes("Ratio'.padStart"));
  assertFalse(html.includes("renderInputOutputRatio"));
  assertFalse(html.includes("Output%"));
});

Deno.test("DashboardPage does not embed production usage key ids in public HTML", () => {
  const html = DashboardPage().toString();

  assertFalse(html.includes("46360b74-2457-4a38-a116-7afdb2894632"));
  assertFalse(html.includes("4969165b-3412-436c-87d9-3fd4770164b5"));
  assertFalse(html.includes("3f2fe5b9-2991-4bb8-bc04-2852f58150ca"));
});

Deno.test("DashboardPage preserves empty cache hit rate chart points", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "return total > 0 ? (detail.cacheRead / total) * 100 : null;",
  );
  assertStringIncludes(
    html,
    "return isTokenChartPercentMetric(this.tokenChartMetric) ? null : 0;",
  );
  assertStringIncludes(
    html,
    "item.parsed.y !== null && (isSearchChart ? item.parsed.y > 0 : (isTokenChartPercentMetric(self.tokenChartMetric) || item.parsed.y > 0))",
  );
});

Deno.test("dashboardApp copies snippets with textarea fallback when Clipboard API is unavailable", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const originalSetTimeout = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout",
  );
  const copiedValues: string[] = [];
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute() {},
    focus() {},
    select() {},
  };
  const document = {
    getElementById(id: string) {
      return { id, clientWidth: 640 };
    },
    createElement(tag: string) {
      assertEquals(tag, "textarea");
      return textarea;
    },
    body: {
      appendChild(node: unknown) {
        assertEquals(node, textarea);
      },
      removeChild(node: unknown) {
        assertEquals(node, textarea);
      },
    },
    execCommand(command: string) {
      assertEquals(command, "copy");
      copiedValues.push(textarea.value);
      return true;
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    value: {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    value: () => 0,
    configurable: true,
  });

  try {
    const { app } = createDashboardHarness({ document });

    await app.copySnippet("test-api-key", "key-1");

    assertEquals(copiedValues, ["test-api-key"]);
    assertEquals(app.copied, "key-1");
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
    if (originalSetTimeout) {
      Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
    }
  }
});

Deno.test("DashboardPage filters search usage tooltip items independently from token metric", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "filter: (item) => item.parsed.y !== null && (isSearchChart ? item.parsed.y > 0 : (isTokenChartPercentMetric(self.tokenChartMetric) || item.parsed.y > 0))",
  );
});

Deno.test("DashboardPage connects percent metric lines across empty points", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "ds.spanGaps = isPercentMetric;",
  );
  assertStringIncludes(
    html,
    "spanGaps: isTokenChartPercentMetric(self.tokenChartMetric)",
  );
});

Deno.test("dashboardApp updates chart data and options when switching summary metrics", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenData = [
    usageRecord(-2, {
      requests: 2,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 5,
      cacheCreationTokens: 5,
    }),
    usageRecord(-1, {
      requests: 3,
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    usageRecord(0, {
      requests: 4,
      inputTokens: 6,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
    }),
  ];

  app.renderTokenCharts();
  assertEquals(charts.length, 2);
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Total Tokens");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(15));
    assert(chart.data.datasets[0].data.includes(27));
    assert(chart.data.datasets[0].data.includes(10));
  }

  app.switchTokenChartMetric("cacheHitRate");
  assertEquals(app.tokenChartMetric, "cacheHitRate");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Cache Hit Rate");
    assertEquals(chart.options.scales.y.stacked, false);
    assertEquals(chart.options.scales.y.suggestedMax, 100);
    assertEquals(chart.data.datasets[0].fill, false);
    assertEquals(chart.data.datasets[0].spanGaps, true);
    assert(chart.data.datasets[0].data.includes(50));
    assert(chart.data.datasets[0].data.includes(75));
    assert(chart.data.datasets[0].data.includes(null));
  }

  app.switchTokenChartMetric("cached");
  assertEquals(app.tokenChartMetric, "cached");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Cached Input");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.options.scales.y.suggestedMax, undefined);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(5));
    assert(chart.data.datasets[0].data.includes(0));
    assert(chart.data.datasets[0].data.includes(3));
  }

  app.switchTokenChartMetric("cachedRate");
  assertEquals(app.tokenChartMetric, "cachedRate");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Cached Rate");
    assertEquals(chart.options.scales.y.stacked, false);
    assertEquals(chart.options.scales.y.suggestedMax, 100);
    assertEquals(chart.data.datasets[0].fill, false);
    assertEquals(chart.data.datasets[0].spanGaps, true);
    assert(chart.data.datasets[0].data.includes(50));
    assert(chart.data.datasets[0].data.includes(0));
  }

  app.switchTokenChartMetric("prefill");
  assertEquals(app.tokenChartMetric, "prefill");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Prefill Input");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.options.scales.y.suggestedMax, undefined);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(5));
    assert(chart.data.datasets[0].data.includes(20));
    assert(chart.data.datasets[0].data.includes(3));
  }

  app.switchTokenChartMetric("requests");
  assertEquals(app.tokenChartMetric, "requests");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Requests");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.options.scales.y.suggestedMax, undefined);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(2));
    assert(chart.data.datasets[0].data.includes(3));
    assert(chart.data.datasets[0].data.includes(4));
  }
});

Deno.test("dashboardApp surfaces backend-precomputed cost on chart and summary", () => {
  const { app, charts } = createDashboardHarness();
  const expectedCost = 0.0004185;
  app.tokenData = [
    usageRecord(0, {
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheCreationTokens: 30,
      cost: expectedCost,
    }),
  ];

  app.renderTokenCharts();
  app.switchTokenChartMetric("cost");

  assertAlmostEquals(app.tokenSummary.cost, expectedCost, 1e-10);
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Est. Cost");
    const nonZeroValues = chart.data.datasets[0].data.filter((v) =>
      typeof v === "number" && v > 0
    );
    assertEquals(nonZeroValues.length, 1);
    assertAlmostEquals(nonZeroValues[0] as number, expectedCost, 1e-10);
  }
});

Deno.test("dashboardApp tooltip shows cached and prefill columns without ratio", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenData = [
    usageRecord(0, {
      requests: 2,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    }),
  ];

  app.renderTokenCharts();

  const chart = charts[0];
  const dataset = chart.data.datasets[0];
  const dataIndex = dataset.data.findIndex((v) => v === 120);
  assert(dataIndex >= 0);

  const callbacks = chart.options.plugins?.tooltip?.callbacks;
  assert(callbacks?.beforeBody);
  assert(callbacks?.label);

  const header = callbacks.beforeBody([{ chart }]);
  const row = callbacks.label({
    chart,
    dataIndex,
    dataset,
    parsed: { y: 120 },
  });

  assertStringIncludes(String(header), "Cost");
  assertStringIncludes(String(header), "Cached%");
  assertFalse(String(header).includes("Prefill%"));
  assertStringIncludes(String(header), "Output");
  assertStringIncludes(String(header), "Hit%");
  assertFalse(String(header).includes("Ratio"));
  assertStringIncludes(row, "120");
  assertStringIncludes(row, "30");
  assertStringIncludes(row, "30.0%");
  assertStringIncludes(row, "70");
  assertStringIncludes(row, "20");
  assertFalse(row.includes("5.00x"));
  assertStringIncludes(row, "75.0%");
});

Deno.test("dashboardApp keeps known usage key colors on selected slots when earlier keys are absent", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenData = [
    usageRecord(-1, {
      keyId: "4969165b-3412-436c-87d9-3fd4770164b5",
      keyName: "Menci",
      keyCreatedAt: "2026-03-09T09:48:00.125Z",
    }),
    usageRecord(0, {
      keyId: "3f2fe5b9-2991-4bb8-bc04-2852f58150ca",
      keyName: "ceerRep",
      keyCreatedAt: "2026-04-22T14:20:03.256Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  const menci = keyChart.data.datasets.find((ds: ChartDataset) =>
    ds._keyId === "4969165b-3412-436c-87d9-3fd4770164b5"
  );
  const ceerRep = keyChart.data.datasets.find((ds: ChartDataset) =>
    ds._keyId === "3f2fe5b9-2991-4bb8-bc04-2852f58150ca"
  );
  assert(menci);
  assert(ceerRep);
  assertEquals(menci.borderColor, "#00e676");
  assertEquals(menci.backgroundColor, "#00e67640");
  assertEquals(ceerRep.borderColor, "#64ffda");
  assertEquals(ceerRep.backgroundColor, "#64ffda40");
});

Deno.test("dashboardApp assigns new usage keys to reordered future color slots by creation order", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenData = [
    usageRecord(-3, {
      keyId: "new-key-1",
      keyName: "Future A",
      keyCreatedAt: "2026-05-01T00:00:00.000Z",
    }),
    usageRecord(-2, {
      keyId: "new-key-2",
      keyName: "Future B",
      keyCreatedAt: "2026-05-02T00:00:00.000Z",
    }),
    usageRecord(-1, {
      keyId: "new-key-3",
      keyName: "Future C",
      keyCreatedAt: "2026-05-03T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  const colorsByKey = new Map(
    keyChart.data.datasets.map((ds: ChartDataset) => [
      ds._keyId,
      ds.borderColor,
    ]),
  );
  assertEquals(colorsByKey.get("new-key-1"), "#ff6e40");
  assertEquals(colorsByKey.get("new-key-2"), "#40c4ff");
  assertEquals(colorsByKey.get("new-key-3"), "#eeff41");
});

Deno.test("dashboardApp keeps future key colors stable when an earlier future key is absent", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenKeyMetadata = [
    {
      id: "new-key-1",
      name: "Future A",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "new-key-2",
      name: "Future B",
      createdAt: "2026-05-02T00:00:00.000Z",
    },
  ];
  app.tokenData = [
    usageRecord(-1, {
      keyId: "new-key-2",
      keyName: "Future B",
      keyCreatedAt: "2026-05-02T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  assertEquals(keyChart.data.datasets[0]._keyId, "new-key-2");
  assertEquals(keyChart.data.datasets[0].borderColor, "#40c4ff");
  assertEquals(keyChart.data.datasets[0].backgroundColor, "#40c4ff40");
});

Deno.test("dashboardApp uses key id to break future key creation-time ties", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenKeyMetadata = [
    {
      id: "new-key-b",
      name: "Alpha renamed",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "new-key-a",
      name: "Zulu renamed",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ];
  app.tokenData = [
    usageRecord(-1, {
      keyId: "new-key-b",
      keyName: "Alpha renamed",
      keyCreatedAt: "2026-05-01T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  assertEquals(keyChart.data.datasets[0]._keyId, "new-key-b");
  assertEquals(keyChart.data.datasets[0].borderColor, "#40c4ff");
  assertEquals(keyChart.data.datasets[0].backgroundColor, "#40c4ff40");
});

Deno.test("dashboardApp keeps model colors on known model-id slots when earlier models are absent", () => {
  const { app, charts } = createDashboardHarness();
  app.allModels = [{ id: "model-a" }, { id: "model-b" }];
  app.tokenData = [
    usageRecord(0, {
      model: "model-b",
    }),
  ];

  app.renderTokenCharts();

  const modelChart = charts[1];
  assertEquals(modelChart.data.datasets[0]._model, "model-b");
  assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  assertEquals(modelChart.data.datasets[0].backgroundColor, "#00e67640");
});

Deno.test("dashboardApp uses merged-id model labels straight from the API", () => {
  const { app, charts } = createDashboardHarness();
  app.allModels = [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-7" }];
  app.tokenData = [
    usageRecord(0, {
      model: "claude-sonnet-4-7",
    }),
  ];

  app.renderTokenCharts();

  const modelChart = charts[1];
  assertEquals(modelChart.data.datasets[0]._model, "claude-sonnet-4-7");
  assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  assertEquals(modelChart.data.datasets[0].backgroundColor, "#00e67640");
});

Deno.test("dashboardApp aggregates usage rows that already share a merged model id", () => {
  const { app, charts } = createDashboardHarness();
  app.allModels = [{ id: "claude-opus-4-7" }];
  app.tokenData = [
    usageRecord(0, {
      model: "claude-opus-4-7",
      inputTokens: 2,
      outputTokens: 3,
    }),
    usageRecord(0, {
      model: "claude-opus-4-7",
      inputTokens: 5,
      outputTokens: 7,
    }),
    usageRecord(0, {
      model: "claude-opus-4-7",
      inputTokens: 11,
      outputTokens: 13,
    }),
  ];

  app.renderTokenCharts();

  const modelChart = charts[1];
  assertEquals(modelChart.data.datasets.length, 1);
  assertEquals(modelChart.data.datasets[0]._model, "claude-opus-4-7");
  assertEquals(
    modelChart.data.datasets[0].data.filter((value) => value !== 0),
    [41],
  );
});

Deno.test("dashboardApp consumes merged model ids straight from /api/models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.startsWith("/api/models")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                model_picker_enabled: true,
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: 1000000,
                    max_prompt_tokens: 936000,
                    max_output_tokens: 64000,
                  },
                },
                supported_endpoints: ["/v1/messages"],
              },
              {
                id: "claude-sonnet-4-7",
                name: "Claude Sonnet 4.7",
                model_picker_enabled: true,
                capabilities: { type: "chat", limits: {} },
                supported_endpoints: ["/responses"],
              },
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                model_picker_enabled: true,
                capabilities: { type: "chat", limits: {} },
                supported_endpoints: ["/responses"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const { app } = createDashboardHarness();
    await app.loadModels();

    assertEquals(app.allModels.map((m: { id: string }) => m.id), [
      "claude-opus-4-7",
      "claude-sonnet-4-7",
      "gpt-5.5",
    ]);
    assertEquals(
      app.filteredChatModels
        .filter((m: { _divider?: boolean }) => !m._divider)
        .map((m: { id: string }) => m.id),
      ["claude-opus-4-7", "claude-sonnet-4-7", "gpt-5.5"],
    );
    assertEquals(app.claudeModelsBig, ["claude-opus-4-7"]);
    assertEquals(app.codexModels, ["gpt-5.5", "claude-sonnet-4-7"]);
    app.codexModel = "claude-sonnet-4-7";
    assertStringIncludes(app.codexSnippet(), 'model = "claude-sonnet-4-7"');
    assertStringIncludes(
      app.claudeCodeSnippet(),
      "ANTHROPIC_MODEL=claude-opus-4-7[1m]",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("dashboardApp waits for model metadata before first usage chart render", async () => {
  const originalFetch = globalThis.fetch;
  let resolveModels!: () => void;
  const modelsResponse = new Promise<Response>((resolve) => {
    resolveModels = () =>
      resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "model-a",
                name: "Model A",
                model_picker_enabled: true,
                capabilities: {},
                supported_endpoints: [],
              },
              {
                id: "model-b",
                name: "Model B",
                model_picker_enabled: true,
                capabilities: {},
                supported_endpoints: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
  });

  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.startsWith("/api/models")) return modelsResponse;
    if (url.startsWith("/api/token-usage")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            records: [usageRecord(0, { model: "model-b" })],
            keys: [],
            keyColorOrder: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.startsWith("/api/search-usage")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            records: [],
            keys: [],
            keyColorOrder: [],
            activeProvider: "disabled",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const { app, charts } = createDashboardHarness();
    app.$nextTick = () => Promise.resolve();
    const usageReady = app.loadUsageTabData(app.loadModels());

    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(app.tokenLoading, true);
    assertEquals(charts.length, 0);

    resolveModels();
    await usageReady;

    const modelChart = charts.at(-1);
    assert(modelChart);
    assertEquals(modelChart.data.datasets[0]._model, "model-b");
    assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("DashboardPage usage summary metric focus styling only shows borders on hover or focus-visible", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "border border-transparent cursor-pointer transition-colors hover:border-white/10 focus:outline-none focus-visible:border-accent-cyan/40",
  );
  assertFalse(html.includes("focus:ring"));
});

Deno.test("DashboardPage renders mobile-friendly dashboard chrome", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "max-w-6xl mx-auto px-4 sm:px-6 pt-4 sm:pt-5 pb-8",
  );
  assertStringIncludes(
    html,
    "order-3 flex w-full max-w-full gap-1 overflow-x-auto rounded-lg bg-surface-800 p-0.5 sm:order-none sm:w-fit",
  );
  assertStringIncludes(
    html,
    "shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm",
  );
});

Deno.test("DashboardPage renders mobile-friendly admin controls", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center",
  );
  assertStringIncludes(html, 'aria-label="Copy API key"');
  assertStringIncludes(html, 'aria-label="Rename API key"');
  assertStringIncludes(html, 'aria-label="Rotate API key"');
  assertStringIncludes(html, 'aria-label="Delete API key"');
  assertStringIncludes(html, "min-h-9 min-w-9");
});

Deno.test("DashboardPage merges Upstream into leftmost Settings tab and places Models before API Keys", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "const TABS = isAdmin ? ['settings', 'models', 'keys', 'usage', 'performance'] : ['models', 'keys', 'usage', 'performance'];",
  );
  assertStringIncludes(html, "const defaultTab = isAdmin ? 'settings' : 'models';");
  assertFalse(html.includes("switchTab('upstream')"));
  assertFalse(html.includes("tab === 'upstream'"));

  const settings = html.indexOf(">\n              Settings\n            </button>");
  const models = html.indexOf(">\n            Models\n          </button>");
  const apiKeys = html.indexOf(">\n            API Keys\n          </button>");
  assert(settings >= 0);
  assert(models > settings);
  assert(apiKeys > models);
});

Deno.test("DashboardPage renders Settings as masonry settings columns", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "grid grid-cols-1 gap-5 lg:grid-cols-2");
  assertStringIncludes(html, "flex flex-col gap-5");
  assertStringIncludes(html, "GitHub Accounts");
  assertStringIncludes(html, "Copilot Quota");
  assertStringIncludes(html, "API Endpoints");
  assertStringIncludes(html, "Web Search");
  assertStringIncludes(html, "Export Data");
  assertStringIncludes(html, "Import Data");
  assertFalse(html.includes("Data Transfer"));
});

Deno.test("DashboardPage renders compact Settings endpoint rows with docs links", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap",
  );
  assertStringIncludes(html, "/v1/messages");
  assertStringIncludes(html, "Anthropic Messages");
  assertStringIncludes(html, "https://docs.anthropic.com/en/api/messages");
  assertStringIncludes(html, "/v1/messages/count_tokens");
  assertStringIncludes(html, "Anthropic Count Tokens");
  assertStringIncludes(
    html,
    "https://docs.anthropic.com/en/api/messages-count-tokens",
  );
  assertStringIncludes(html, "/v1/responses");
  assertStringIncludes(html, "OpenAI Responses");
  assertStringIncludes(
    html,
    "https://platform.openai.com/docs/api-reference/responses/create",
  );
  assertStringIncludes(html, "/v1/chat/completions");
  assertStringIncludes(html, "OpenAI Chat Completions");
  assertStringIncludes(
    html,
    "https://platform.openai.com/docs/api-reference/chat/create",
  );
  assertStringIncludes(html, "/v1/embeddings");
  assertStringIncludes(html, "OpenAI Embeddings");
  assertStringIncludes(
    html,
    "https://platform.openai.com/docs/api-reference/embeddings/create",
  );
  assertStringIncludes(html, "/v1/models");
  assertStringIncludes(html, "OpenAI Models");
  assertStringIncludes(
    html,
    "https://platform.openai.com/docs/api-reference/models/list",
  );
});

Deno.test("DashboardPage uses frontend-only selected GitHub account for quota display", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "selectedGithubAccountId: null");
  assertStringIncludes(html, '@click="selectGithubAccount(acct.id)"');
  assertStringIncludes(html, "selectedGithubAccountId === acct.id");
  assertStringIncludes(html, "'/api/copilot-quota?user_id='");
  assertStringIncludes(html, "async selectGithubAccount(userId)");
  assertStringIncludes(html, "class=\"ml-1 min-w-0 truncate text-gray-500\"");
  assertStringIncludes(html, "'· @' + (githubAccounts.find");
  assertStringIncludes(html, "usageData.copilot_plan");
  assertFalse(html.includes("Selected account:"));
  assertFalse(html.includes("/auth/github/switch"));
});

Deno.test("DashboardPage only shows GitHub account backoff status when models are cooling down", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, 'x-show="hasUnavailableModels(acct)"');
  assertStringIncludes(html, "return count + ' backoff';");
  assertStringIncludes(html, 'x-text="unavailableBadgeText(acct)"');
  assertStringIncludes(html, 'x-text="cooldownRecoveryText(status)"');
  assertStringIncludes(html, "expiresAt > this.now");
  assertStringIncludes(html, "return 'in ' + this.cooldownRemaining(status);");
  assertStringIncludes(
    html,
    "flex flex-col gap-1 rounded-md bg-white/[0.03] px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3",
  );
  assertStringIncludes(
    html,
    "w-fit shrink-0 font-mono text-[10px] text-accent-amber",
  );
  assertFalse(html.includes("'Ready'"));
  assertFalse(html.includes(" limited"));
  assertFalse(html.includes("expired"));
});

Deno.test("DashboardPage renders Settings import preview responsively", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4",
  );
  assertStringIncludes(html, "flex flex-col gap-3 mb-4 sm:flex-row");
  assertFalse(html.includes("grid grid-cols-4 gap-3 mb-4"));
});

Deno.test("DashboardPage renders Models playground as a mobile stack", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "glass-card glow-border animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row",
  );
  assertStringIncludes(
    html,
    "max-h-56 w-full shrink-0 border-b border-white/[0.06] flex flex-col lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r",
  );
  assertFalse(
    html.includes(
      'style="height: calc(100vh - 140px); display: flex; overflow: hidden;"',
    ),
  );
});

Deno.test("DashboardPage renders search usage chart after token summary content", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "Search Usage — Per Key");
  assertStringIncludes(html, "searchUsageActiveProvider !== 'disabled'");
  assertStringIncludes(html, "searchUsageChartByKey");
  assert(
    html.indexOf("Search Usage — Per Key") > html.indexOf("Cache Hit Rate"),
  );
});

Deno.test("DashboardPage import preview includes usage and performance records", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "searchUsage: 0");
  assertStringIncludes(html, "performance: 0");
  assertStringIncludes(
    html,
    "searchUsage: Array.isArray(json.data.searchUsage) ? json.data.searchUsage.length : 0",
  );
  assertStringIncludes(
    html,
    "performance: Array.isArray(json.data.performance) ? json.data.performance.length : 0",
  );
  assertStringIncludes(html, "Search Usage Records");
  assertStringIncludes(html, 'x-text="importPreview.searchUsage"');
  assertStringIncludes(html, "Performance Records");
  assertStringIncludes(html, 'x-text="importPreview.performance"');
  assertStringIncludes(
    html,
    "result.imported.searchUsage + ' search usage records, '",
  );
  assertStringIncludes(
    html,
    "result.imported.performance + ' performance records'",
  );
});

Deno.test("DashboardPage makes performance export opt-in", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "exportIncludePerformance: false");
  assertStringIncludes(html, "Include Performance Telemetry");
  assertStringIncludes(html, "include_performance=1");
});

Deno.test("dashboardApp renders search usage per-key datasets for active provider only", () => {
  const { app, charts } = createDashboardHarness();
  app.searchUsageActiveProvider = "tavily";
  app.searchUsageData = [
    searchUsageRecord(-1, {
      provider: "tavily",
      keyId: "key-a",
      keyName: "Search A",
      requests: 5,
    }),
    searchUsageRecord(0, {
      provider: "microsoft-grounding",
      keyId: "key-b",
      keyName: "Search B",
      requests: 7,
    }),
  ];

  app.renderTokenCharts();

  const searchKeyChart = charts.find((chart) =>
    (chart.canvas as { id?: string }).id === "searchUsageChartByKey"
  );
  assert(searchKeyChart);
  assertEquals(searchKeyChart.data.datasets.length, 1);
  assertEquals(searchKeyChart.data.datasets[0]._keyId, "key-a");
  assertEquals(searchKeyChart.data.datasets[0].label, "Search A");
  assert(searchKeyChart.data.datasets[0].data.includes(5));
  assertFalse(searchKeyChart.data.datasets[0].data.includes(7));
});
