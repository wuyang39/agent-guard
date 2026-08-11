import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { P2RunGroup } from "../api/types";
import * as fileRunStoreModule from "./fileRunStore";

test("run group JSON writes replace the destination atomically", async (t) => {
  const candidate = (fileRunStoreModule as unknown as {
    writeJsonAtomically?: (
      filePath: string,
      data: unknown,
      hooks?: { rename?: (source: string, destination: string) => Promise<void> },
    ) => Promise<void>;
  }).writeJsonAtomically;
  assert.equal(typeof candidate, "function");

  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "run-groups.json");

  await writeFile(
    destination,
    JSON.stringify([{ runGroupId: "run_group.previous" }]),
    "utf8",
  );
  let valueBeforeRename: unknown;
  await candidate!(destination, [{ runGroupId: "run_group.atomic" }], {
    rename: async (source, target) => {
      valueBeforeRename = JSON.parse(await readFile(target, "utf8"));
      await rename(source, target);
    },
  });

  assert.deepEqual(valueBeforeRename, [{ runGroupId: "run_group.previous" }]);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), [
    { runGroupId: "run_group.atomic" },
  ]);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("failed run group JSON replacement preserves the prior file", async (t) => {
  const candidate = (fileRunStoreModule as unknown as {
    writeJsonAtomically?: (
      filePath: string,
      data: unknown,
      hooks?: { rename?: (source: string, destination: string) => Promise<void> },
    ) => Promise<void>;
  }).writeJsonAtomically;
  assert.equal(typeof candidate, "function");

  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "run-groups.json");
  const previous = [{ runGroupId: "run_group.previous" }];
  await writeFile(destination, JSON.stringify(previous), "utf8");

  await assert.rejects(
    () => candidate!(destination, [{ runGroupId: "run_group.rejected" }], {
      rename: async () => {
        throw new Error("injected rename failure");
      },
    }),
    /injected rename failure/,
  );

  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), previous);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("legacy native guard coverage from the current output shape gains safe defaults", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./test-fixtures/legacy-native-guard-run-group.json", import.meta.url),
    "utf8",
  )) as P2RunGroup;
  const legacyCoverage = fixture.nativeGuardCoverage as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(legacyCoverage, "sessions"), false);
  assert.equal(Object.hasOwn(legacyCoverage, "mismatchCount"), false);

  const candidate = (fileRunStoreModule as unknown as {
    normalizeStoredRunGroup?: (runGroup: P2RunGroup) => P2RunGroup;
  }).normalizeStoredRunGroup;
  assert.equal(typeof candidate, "function");

  const normalized = candidate!(fixture);
  assert.deepEqual(normalized.nativeGuardCoverage, {
    ...fixture.nativeGuardCoverage,
    mismatchCount: 0,
    sessions: [],
    runtimeFailures: [],
  });
  assert.equal(Object.hasOwn(legacyCoverage, "sessions"), false);
});
