// GET /api/performance — query backend-aggregated latency telemetry.
// Visibility intentionally mirrors /api/token-usage: any authenticated user can
// view shared usage/performance records for dashboard observability.

import type { Context } from "hono";
import { listApiKeys } from "../../lib/api-keys.ts";
import { getRepo } from "../../repo/index.ts";
import type { PerformanceMetricScope } from "../../repo/types.ts";
import { USAGE_KEY_COLOR_ORDER } from "../usage-key-colors.ts";
import {
  aggregatePerformanceForDisplay,
  type PerformanceBucketGranularity,
  type PerformanceGroupBy,
} from "./aggregate.ts";

const BUCKETS = new Set<PerformanceBucketGranularity>([
  "hour",
  "4h",
  "8h",
  "day",
  "all",
]);
const GROUP_BYS = new Set<PerformanceGroupBy>([
  "none",
  "keyId",
  "model",
  "sourceApi",
  "targetApi",
  "runtimeLocation",
]);
const METRIC_SCOPES = new Set<PerformanceMetricScope>([
  "request_total",
  "upstream_success",
]);

export const performanceTelemetry = async (c: Context) => {
  const params = readPerformanceQuery(c, {
    bucket: "hour",
    groupBy: "model",
  });
  if (params.type === "error") return c.json({ error: params.error }, 400);

  const includeKeyMetadata = c.req.query("include_key_metadata") === "1";

  const rawRecords = await getRepo().performance.query({
    keyId: params.keyId,
    start: params.start,
    end: params.end,
    metricScope: params.metricScope,
  });
  const records = aggregatePerformanceForDisplay(rawRecords, {
    bucket: params.bucket,
    groupBy: params.groupBy,
    timezoneOffsetMinutes: params.timezoneOffsetMinutes,
  });

  if (!includeKeyMetadata) return c.json({ records });

  const keys = await listApiKeys();
  const keyMetadata = keys
    .map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  return c.json({
    records,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
  });
};

export const performanceOverview = async (c: Context) => {
  const params = readPerformanceQuery(c, {
    bucket: "hour",
    groupBy: "model",
  });
  if (params.type === "error") return c.json({ error: params.error }, 400);

  const rawRecords = await getRepo().performance.query({
    keyId: params.keyId,
    start: params.start,
    end: params.end,
    metricScope: params.metricScope,
  });
  const baseOptions = {
    timezoneOffsetMinutes: params.timezoneOffsetMinutes,
  };

  return c.json({
    series: aggregatePerformanceForDisplay(rawRecords, {
      ...baseOptions,
      bucket: params.bucket,
      groupBy: "model",
    }),
    summaryRows: aggregatePerformanceForDisplay(rawRecords, {
      ...baseOptions,
      bucket: "all",
      groupBy: "none",
    }),
    modelRows: aggregatePerformanceForDisplay(rawRecords, {
      ...baseOptions,
      bucket: "all",
      groupBy: "model",
    }),
    runtimeRows: aggregatePerformanceForDisplay(rawRecords, {
      ...baseOptions,
      bucket: "all",
      groupBy: "runtimeLocation",
    }),
  });
};

type PerformanceQueryParams = {
  type: "ok";
  keyId: string | undefined;
  start: string;
  end: string;
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  metricScope: PerformanceMetricScope;
  timezoneOffsetMinutes: number;
} | {
  type: "error";
  error: string;
};

function readPerformanceQuery(
  c: Context,
  defaults: {
    bucket: PerformanceBucketGranularity;
    groupBy: PerformanceGroupBy;
  },
): PerformanceQueryParams {
  const keyId = c.req.query("key_id") || undefined;
  const start = c.req.query("start") ?? "";
  const end = c.req.query("end") ?? "";
  const bucket = readEnum(c.req.query("bucket"), BUCKETS, defaults.bucket);
  const groupBy = readEnum(
    c.req.query("group_by"),
    GROUP_BYS,
    defaults.groupBy,
  );
  const metricScope = readEnum(
    c.req.query("metric_scope"),
    METRIC_SCOPES,
    "request_total" as PerformanceMetricScope,
  );
  const timezoneOffsetMinutes = Number(
    c.req.query("timezone_offset_minutes") ?? "0",
  );

  if (!start || !end) {
    return {
      type: "error",
      error: "start and end query parameters are required (e.g. 2026-03-09T00)",
    };
  }
  if (
    !Number.isFinite(timezoneOffsetMinutes) ||
    timezoneOffsetMinutes < -1440 ||
    timezoneOffsetMinutes > 1440
  ) {
    return {
      type: "error",
      error: "timezone_offset_minutes must be between -1440 and 1440",
    };
  }
  if (!bucket || !groupBy || !metricScope) {
    return { type: "error", error: "Invalid performance query parameter" };
  }

  return {
    type: "ok",
    keyId,
    start,
    end,
    bucket,
    groupBy,
    metricScope,
    timezoneOffsetMinutes,
  };
}

function readEnum<T extends string>(
  value: string | undefined,
  values: Set<T>,
  fallback: T,
): T | null {
  if (value === undefined) return fallback;
  return values.has(value as T) ? value as T : null;
}
