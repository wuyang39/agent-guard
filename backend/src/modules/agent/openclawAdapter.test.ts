import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkOpenClawAvailable,
  drainOpenClawRuntimeEvidence,
  OpenClawAdapter,
  resolveOpenClawCliInvocation,
} from "./openclawAdapter";

test("guarded runtime evidence drain fails when the event store is unavailable", async () => {
  const store = {
    async listByRun() {
      throw new Error("OPENCLAW_GATEWAY_TOKEN=super-secret store unavailable");
    },
    async listRecordsByRun() {
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
    async listByRun() {
      throw new Error("store unavailable");
    },
    async listRecordsByRun() {
      return [];
    },
  } as never;

  assert.deepEqual(
    await drainOpenClawRuntimeEvidence(store, "run-1", false),
    { nativeGuardEvents: [], supervisionRecords: [] },
  );
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
