import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBaseUrl } from "./core";
import { realtimeApi } from "./realtime";

test("live supervision stream defaults to realtime-only replay mode", () => {
  assert.equal(
    realtimeApi.liveSupervisionUrl(),
    `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=0`,
  );
});

test("live supervision stream can explicitly include replay history", () => {
  assert.equal(
    realtimeApi.liveSupervisionUrl({ includeHistory: true }),
    `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=1`,
  );
});
