import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { RunE2ERequest } from "../../types";
import {
  DetectionRunConflictError,
  releaseDetectionRunReservation,
  reserveDetectionRun,
  type DetectionRunReservation,
  type RunE2EResult,
} from "../../../services/e2eRunService";
import { testRunRoutes } from "./handlers";

type RunE2E = typeof import("../../../services/e2eRunService").runE2E;

const OPENCLAW_REQUEST: RunE2ERequest = {
  adapterKind: "openclaw",
  agent: { name: "Concurrent OpenClaw" },
  generateDefenseReport: false,
};

test("sync and async OpenClaw conflicts return HTTP 409 without releasing the owner", async () => {
  const owner = reserveDetectionRun();
  const app = Fastify({ logger: false });
  await app.register(testRunRoutes);

  try {
    for (const url of [
      "/api/v1/test-runs/e2e",
      "/api/v1/test-runs/e2e?async=1",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        payload: OPENCLAW_REQUEST,
      });

      assert.equal(response.statusCode, 409, url);
      assert.equal(response.json().error.code, "DETECTION_RUN_CONFLICT", url);
    }

    assert.throws(() => reserveDetectionRun(), DetectionRunConflictError);
  } finally {
    releaseDetectionRunReservation(owner);
    await app.close();
  }
});

test("async OpenClaw runs reserve before returning HTTP 202 and acquire only once", async () => {
  let capturedReservation: DetectionRunReservation | undefined;
  let runCalls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const never = new Promise<RunE2EResult>(() => undefined);
  const app = Fastify({ logger: false });
  const runE2E: RunE2E = async (_request, _runGroup, _factory, reservation) => {
    runCalls += 1;
    capturedReservation = reservation;
    markStarted();
    return never;
  };

  await app.register(testRunRoutes, {
    saveRunGroup: async () => undefined,
    runE2E,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/test-runs/e2e?async=1",
      payload: OPENCLAW_REQUEST,
    });
    await started;

    assert.equal(response.statusCode, 202);
    assert.equal(runCalls, 1);
    assert.ok(capturedReservation);
    assert.throws(() => reserveDetectionRun(), DetectionRunConflictError);
  } finally {
    releaseDetectionRunReservation(capturedReservation);
    await app.close();
  }
});

test("async OpenClaw queue persistence failure releases its reservation", async () => {
  const app = Fastify({ logger: false });
  await app.register(testRunRoutes, {
    saveRunGroup: async () => {
      throw new Error("queue persistence failed");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/test-runs/e2e?async=1",
    payload: OPENCLAW_REQUEST,
  });

  assert.equal(response.statusCode, 500);
  const nextOwner = reserveDetectionRun();
  releaseDetectionRunReservation(nextOwner);
  await app.close();
});
