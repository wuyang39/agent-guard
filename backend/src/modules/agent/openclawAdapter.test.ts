import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildOpenClawProcessEnv,
  checkOpenClawAvailable,
  drainOpenClawRuntimeEvidence,
  OpenClawAdapter,
  resolveOpenClawCliInvocation,
} from "./openclawAdapter";

test("OpenClaw child environments strip backend-only browser and control secrets", () => {
  const env = buildOpenClawProcessEnv({
    AGENT_GUARD_UI_BOOTSTRAP_TOKEN: "bootstrap-secret",
    AGENT_GUARD_CONTROL_TOKEN: "control-secret",
    VITE_AGENT_GUARD_CONTROL_TOKEN: "dev-control-secret",
    agent_guard_control_token: "lower-control-secret",
    Agent_Guard_Ui_Bootstrap_Token: "mixed-bootstrap-secret",
    OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
  });

  assert.equal(env.AGENT_GUARD_UI_BOOTSTRAP_TOKEN, undefined);
  assert.equal(env.AGENT_GUARD_CONTROL_TOKEN, undefined);
  assert.equal(env.VITE_AGENT_GUARD_CONTROL_TOKEN, undefined);
  assert.equal(env.agent_guard_control_token, undefined);
  assert.equal(env.Agent_Guard_Ui_Bootstrap_Token, undefined);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "gateway-secret");
});

test("guarded runtime evidence drain fails when the event store is unavailable", async () => {
  const store = {
    async listBySession() {
      throw new Error("OPENCLAW_GATEWAY_TOKEN=super-secret store unavailable");
    },
    async listRecordsBySession() {
      return [];
    },
  } as never;

  await assert.rejects(
    drainOpenClawRuntimeEvidence(store, "run-1", true),
    (error: Error) => {
      assert.match(error.message, /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
});

test("optional runtime evidence drain retains fail-open compatibility", async () => {
  const store = {
    async listBySession() {
      throw new Error("store unavailable");
    },
    async listRecordsBySession() {
      return [];
    },
  } as never;

  assert.deepEqual(
    await drainOpenClawRuntimeEvidence(store, "run-1", false),
    { nativeGuardEvents: [], supervisionRecords: [] },
  );
});

test("Guard ON uses one canonical session for lease, CLI, and evidence while preserving the raw run id", async () => {
  const fixture = await createCompletingCliFixture("guard-on");
  const rawRunId = "run.guard-on.canonical";
  const canonicalSessionKey = `agent:main:${rawRunId}`;
  const activations: Array<{ rootSessionKey: string; runGroupId: string }> = [];
  const revoked: string[] = [];
  const eventQueries: string[] = [];
  const recordQueries: string[] = [];

  try {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      env: fixture.env,
      nativeGuardRequired: true,
      guardLease: {
        async activate(input) {
          activations.push(input);
          return { leaseId: "lease.canonical", leaseEpoch: 1 };
        },
        async revoke(leaseId) {
          revoked.push(leaseId);
        },
      },
      nativeGuardEventStore: {
        async listByRun() {
          throw new Error("legacy run-id event query must not be used");
        },
        async listRecordsByRun() {
          throw new Error("legacy run-id record query must not be used");
        },
        async listBySession(sessionKey: string) {
          eventQueries.push(sessionKey);
          return [];
        },
        async listRecordsBySession(sessionKey: string) {
          recordQueries.push(sessionKey);
          return [];
        },
      } as never,
    });
    const session = await adapter.createSession(testAgent(), testAdapterConfig());
    const result = await session.sendTask(
      testTask("guard-on"),
      undefined,
      { runId: rawRunId, caseId: "case.guard-on", agentId: "agent.fixture" },
    );
    const evidence = await session.drainRuntimeEvidence?.();
    const args = JSON.parse(await readFile(fixture.argsPath, "utf8")) as string[];
    const sessionKeyIndex = args.indexOf("--session-key");

    assert.deepEqual(activations, [{
      rootSessionKey: canonicalSessionKey,
      runGroupId: rawRunId,
    }]);
    assert.equal(args[sessionKeyIndex + 1], canonicalSessionKey);
    assert.equal(result.runId, rawRunId);
    assert.equal(result.status, "completed");
    assert.deepEqual(eventQueries, [canonicalSessionKey, canonicalSessionKey]);
    assert.deepEqual(recordQueries, [canonicalSessionKey]);
    assert.deepEqual(revoked, ["lease.canonical"]);
    assert.deepEqual(evidence?.reconciliation, {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    });
    assert.deepEqual(evidence && {
      sessionKey: evidence.sessionKey,
      leaseId: evidence.leaseId,
      leaseEpoch: evidence.leaseEpoch,
    }, {
      sessionKey: canonicalSessionKey,
      leaseId: "lease.canonical",
      leaseEpoch: 1,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a reused guarded session does not drain state from a run before an activation failure", async () => {
  const fixture = await createCompletingCliFixture("guard-on-reused");
  let activationCount = 0;
  let eventStoreQueryCount = 0;

  try {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      env: fixture.env,
      nativeGuardRequired: true,
      guardLease: {
        async activate() {
          activationCount += 1;
          if (activationCount === 1) {
            return { leaseId: "lease.first", leaseEpoch: 1 };
          }
          throw new Error("second activation failed");
        },
        async revoke() {
          throw new Error("first revoke failed");
        },
      },
      nativeGuardEventStore: {
        async listByRun() {
          throw new Error("legacy run-id event query must not be used");
        },
        async listRecordsByRun() {
          throw new Error("legacy run-id record query must not be used");
        },
        async listBySession() {
          eventStoreQueryCount += 1;
          return [];
        },
        async listRecordsBySession() {
          eventStoreQueryCount += 1;
          return [];
        },
      },
    });
    const session = await adapter.createSession(testAgent(), testAdapterConfig());
    const first = await session.sendTask(
      testTask("guard-on-first"),
      undefined,
      { runId: "run.guard-on.first", caseId: "case.guard-on-first", agentId: "agent.fixture" },
    );
    const second = await session.sendTask(
      testTask("guard-on-second"),
      undefined,
      { runId: "run.guard-on.second", caseId: "case.guard-on-second", agentId: "agent.fixture" },
    );

    assert.equal(first.status, "completed");
    assert.equal(second.status, "failed");
    assert.match(second.error ?? "", /second activation failed/);
    assert.equal(eventStoreQueryCount, 1);
    assert.ok(session.drainRuntimeEvidence);
    await assert.rejects(
      () => session.drainRuntimeEvidence!(),
      /NATIVE_GUARD_EVIDENCE_UNAVAILABLE/,
    );
    assert.equal(eventStoreQueryCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Guard OFF keeps the raw CLI session key and never activates a lease", async () => {
  const fixture = await createCompletingCliFixture("guard-off");
  const rawRunId = "run.guard-off.raw";
  let activationCount = 0;

  try {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      env: fixture.env,
      nativeGuardRequired: false,
      guardLease: {
        async activate() {
          activationCount += 1;
          return { leaseId: "lease.unexpected", leaseEpoch: 1 };
        },
        async revoke() {},
      },
    });
    const session = await adapter.createSession(testAgent(), testAdapterConfig());
    const result = await session.sendTask(
      testTask("guard-off"),
      undefined,
      { runId: rawRunId, caseId: "case.guard-off", agentId: "agent.fixture" },
    );
    const args = JSON.parse(await readFile(fixture.argsPath, "utf8")) as string[];
    const sessionKeyIndex = args.indexOf("--session-key");

    assert.equal(args[sessionKeyIndex + 1], rawRunId);
    assert.equal(activationCount, 0);
    assert.equal(result.runId, rawRunId);
    assert.equal(result.status, "completed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Guard OFF ignores an injected native event store even when JSONL contains a tool call", async () => {
  const fixture = await createCompletingCliFixture("guard-off-store", {
    toolCall: true,
  });
  const rawRunId = "run.guard-off.store";
  let activationCount = 0;
  let eventStoreQueryCount = 0;

  try {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      env: fixture.env,
      nativeGuardRequired: false,
      guardLease: {
        async activate() {
          activationCount += 1;
          return { leaseId: "lease.unexpected", leaseEpoch: 1 };
        },
        async revoke() {},
      },
      nativeGuardEventStore: {
        async listByRun() {
          eventStoreQueryCount += 1;
          return [];
        },
        async listRecordsByRun() {
          eventStoreQueryCount += 1;
          return [];
        },
        async listBySession() {
          eventStoreQueryCount += 1;
          return [];
        },
        async listRecordsBySession() {
          eventStoreQueryCount += 1;
          return [];
        },
      },
    });
    const session = await adapter.createSession(testAgent(), testAdapterConfig());
    const result = await session.sendTask(
      testTask("guard-off-store"),
      undefined,
      { runId: rawRunId, caseId: "case.guard-off-store", agentId: "agent.fixture" },
    );
    const evidence = await session.drainRuntimeEvidence?.();
    const args = JSON.parse(await readFile(fixture.argsPath, "utf8")) as string[];
    const sessionKeyIndex = args.indexOf("--session-key");

    assert.equal(result.status, "completed");
    assert.equal(result.runId, rawRunId);
    assert.equal(args[sessionKeyIndex + 1], rawRunId);
    assert.equal(activationCount, 0);
    assert.equal(eventStoreQueryCount, 0);
    assert.deepEqual(evidence, {
      nativeGuardEvents: [],
      supervisionRecords: [],
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("executes a controlled Windows cmd wrapper outside an npm layout without a shell", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-controlled-wrapper-"));
  const entry = path.join(root, "dist", "cli.js");
  const wrapper = path.join(root, "openclaw-agentguard.cmd");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, [
    "if (process.argv[2] === '--version') {",
    "  console.log('OpenClaw 2026.7.1-agentguard.1');",
    "} else {",
    "  console.log(JSON.stringify(process.argv.slice(2)));",
    "}",
  ].join("\n"), "utf8");
  await writeFile(
    wrapper,
    '@echo off\r\nnode "%~dp0dist\\cli.js" %*\r\n',
    "utf8",
  );

  try {
    const availability = await checkOpenClawAvailable(wrapper);
    assert.deepEqual(availability, {
      available: true,
      version: "OpenClaw 2026.7.1-agentguard.1",
    });

    const invocation = resolveOpenClawCliInvocation(wrapper);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.argsPrefix, [entry]);
    assert.equal(invocation.shell, false);
    const untrustedArgument = "value & echo SHELL_INJECTION";
    const result = spawnSync(
      invocation.command,
      [...invocation.argsPrefix, untrustedArgument],
      { shell: invocation.shell, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [untrustedArgument]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executes explicit JavaScript OpenClaw CLI entrypoints through Node without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-js-entrypoint-"));
  try {
    for (const extension of ["mjs", "js", "cjs"]) {
      const entry = path.join(root, `openclaw.${extension}`);
      await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");

      const invocation = resolveOpenClawCliInvocation(entry);

      assert.equal(invocation.command, process.execPath);
      assert.deepEqual(invocation.argsPrefix, [path.resolve(entry)]);
      assert.equal(invocation.displayPath, entry);
      assert.equal(invocation.shell, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter abort signal terminates an in-flight OpenClaw CLI run", async () => {
  const fixture = await createBlockingCliFixture();
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;

  try {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      timeoutMs: 60_000,
      env: { OPENCLAW_TEST_PID_PATH: fixture.pidPath },
      signal: controller.signal,
    });
    const session = await adapter.createSession(
      {
        schemaVersion: "mvp-1",
        agentId: "agent.abort",
        name: "Abort fixture",
        adapterType: "openclaw",
      } as never,
      {
        schemaVersion: "mvp-1",
        adapterId: "adapter.abort",
        agentId: "agent.abort",
        adapterType: "openclaw",
        timeoutMs: 60_000,
      } as never,
    );
    run = session.sendTask(
      {
        taskId: "task.abort",
        caseId: "case.abort",
        instruction: "wait until aborted",
        promptIds: [],
        resourceIds: [],
      },
      undefined,
      {
        runId: "run.abort",
        caseId: "case.abort",
        agentId: "agent.abort",
      },
    );

    await waitForFixturePid(fixture.pidPath);
    controller.abort();
    const result = await settleWithin(run, 1_500) as {
      status?: string;
      error?: string;
    };
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /aborted|abort/i);
  } finally {
    await terminateFixtureProcess(fixture.pidPath);
    if (run) await Promise.allSettled([run]);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createBlockingCliFixture(): Promise<{
  root: string;
  cliPath: string;
  pidPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-adapter-abort-"));
  const entry = path.join(root, "cli.mjs");
  const pidPath = path.join(root, "pid.txt");
  await writeFile(entry, [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.OPENCLAW_TEST_PID_PATH, String(process.pid));",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });

  if (process.platform !== "win32") {
    return { root, cliPath: entry, pidPath };
  }
  const cliPath = path.join(root, "openclaw.cmd");
  await writeFile(
    cliPath,
    '@echo off\r\nnode "%~dp0cli.mjs" %*\r\n',
    "utf8",
  );
  return { root, cliPath, pidPath };
}

async function createCompletingCliFixture(
  name: string,
  options: { toolCall?: boolean } = {},
): Promise<{
  root: string;
  cliPath: string;
  argsPath: string;
  env: Record<string, string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `openclaw-adapter-${name}-`));
  const stateDir = path.join(root, "state");
  const sessionFile = path.join(stateDir, "session.jsonl");
  const argsPath = path.join(root, "args.json");
  const cliPath = path.join(root, "cli.mjs");
  await mkdir(stateDir, { recursive: true });
  const content = options.toolCall
    ? [{
        type: "toolCall",
        id: "call.guard-off.1",
        name: "read",
        arguments: { path: "README.md" },
      }]
    : [{ type: "text", text: "done" }];
  await writeFile(sessionFile, `${JSON.stringify({
    type: "message",
    timestamp: "2026-08-07T00:00:00.000Z",
    message: { role: "assistant", content },
  })}\n`, "utf8");
  await writeFile(cliPath, [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.OPENCLAW_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
    "const output = {",
    "  status: 'ok',",
    "  result: {",
    "    payloads: [{ text: 'done', mediaUrl: null }],",
    "    meta: { agentMeta: { sessionFile: process.env.OPENCLAW_TEST_SESSION_FILE, sessionId: 'session.fixture' } },",
    "  },",
    "};",
    "process.stdout.write(JSON.stringify(output));",
  ].join("\n"), "utf8");
  return {
    root,
    cliPath,
    argsPath,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_SESSION_FILE: sessionFile,
      OPENCLAW_TEST_ARGS_PATH: argsPath,
    },
  };
}

function testAgent() {
  return {
    schemaVersion: "mvp-1",
    agentId: "agent.fixture",
    name: "OpenClaw fixture",
    adapterType: "openclaw",
  } as never;
}

function testAdapterConfig() {
  return {
    schemaVersion: "mvp-1",
    adapterId: "adapter.fixture",
    agentId: "agent.fixture",
    adapterType: "openclaw",
    timeoutMs: 10_000,
  } as never;
}

function testTask(name: string) {
  return {
    taskId: `task.${name}`,
    caseId: `case.${name}`,
    instruction: "return done",
    promptIds: [],
    resourceIds: [],
  };
}

async function waitForFixturePid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt(await readFile(pidPath, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("OpenClaw CLI fixture did not start.");
}

async function terminateFixtureProcess(pidPath: string): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The abort path may have already reaped the process.
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
