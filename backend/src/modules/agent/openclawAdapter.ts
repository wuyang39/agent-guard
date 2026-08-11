/**
 * openclawAdapter — OpenClaw CLI Adapter (AgentAdapter 实现)
 *
 * 定位: 真实 OpenClaw 行为采集。CLI 检测阶段负责生成 trace、
 * RiskReport、DetectionReport、RiskProfile 和 PolicyPack；实时监督
 * 由 OpenClaw realtime MCP 入口承接。
 */

import fs from "node:fs";
import path from "node:path";
import { stripBackendOnlySecrets } from "../runtime/childProcessEnv";
import { spawn } from "node:child_process";
import { nowIso } from "../../shared";
import type {
  AgentAdapter,
  AgentNativeGuardRuntimeEvidence,
  AgentRunMeta,
  AgentSession,
  NativeGuardReconciliationSummary,
} from "./agentAdapter";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "@agent-guard/contracts";
import { runOpenClawSession } from "./openclawSession";
import { scrubSecrets } from "../../shared/scrubSecrets";
import { canonicalizeOpenClawSessionKey } from "./openclawSessionIdentity";

export type OpenClawAdapterOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  cliPath?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  nativeGuardRequired?: boolean;
  /** Task 12: Native guard event store for draining runtime evidence. */
  nativeGuardEventStore?: import("./openclawSession").OpenClawRunOptions["nativeGuardEventStore"];
  /** Task 14: Lease activation per-session. The sandbox coordinator
   *  is already configured with the correct Gateway token and URL. */
  guardLease?: {
    activate(input: {
      rootSessionKey: string; runGroupId: string;
    }): Promise<{ leaseId: string; leaseEpoch: number }>;
    revoke(leaseId: string): Promise<void>;
  };
};

type NativeGuardRuntimeStore = NonNullable<
  OpenClawAdapterOptions["nativeGuardEventStore"]
>;

export async function drainOpenClawRuntimeEvidence(
  store: NativeGuardRuntimeStore,
  sessionKey: string,
  required: boolean,
): Promise<{
  nativeGuardEvents: import("@agent-guard/contracts").NativeGuardEvent[];
  supervisionRecords: import("@agent-guard/contracts").RuntimeSupervisionRecord[];
}> {
  try {
    const [nativeGuardEvents, supervisionRecords] = await Promise.all([
      store.listBySession(sessionKey),
      store.listRecordsBySession(sessionKey),
    ]);
    return { nativeGuardEvents, supervisionRecords };
  } catch (error) {
    if (required) {
      const message = scrubSecrets(
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(`NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${message}`);
    }
    return { nativeGuardEvents: [], supervisionRecords: [] };
  }
}

export function resolveOpenClawCliPath(preferredCliPath?: string): string {
  if (preferredCliPath?.trim()) {
    return resolveCommandPath(preferredCliPath.trim());
  }
  for (const candidate of [process.env.OPENCLAW_CLI, "openclaw"].filter((value): value is string => Boolean(value && value.trim()))) {
    if (candidate === "openclaw") {
      return resolveCommandPath(candidate);
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveCommandPath(process.env.OPENCLAW_CLI ?? "openclaw");
}

export type OpenClawCliInvocation = {
  command: string;
  argsPrefix: string[];
  displayPath: string;
  shell: boolean;
  env?: Record<string, string>;
};

export function buildOpenClawProcessEnv(
  extraEnv?: Record<string, string | undefined>,
  inheritProcessEnv = true,
): NodeJS.ProcessEnv {
  return stripBackendOnlySecrets({
    ...(inheritProcessEnv ? process.env : minimalProcessEnv()),
    ...extraEnv,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "*",
    no_proxy: "*",
  });
}

function minimalProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function resolveOpenClawCliInvocation(preferredCliPath?: string): OpenClawCliInvocation {
  const cliPath = resolveOpenClawCliPath(preferredCliPath);
  const javaScriptTarget = resolveJavaScriptCliTarget(cliPath);
  if (javaScriptTarget) {
    return {
      command: process.execPath,
      argsPrefix: [javaScriptTarget],
      displayPath: cliPath,
      shell: false,
    };
  }
  const nodeTarget = resolveWindowsNpmShimTarget(cliPath) ??
    resolveControlledWindowsCmdTarget(cliPath);
  if (nodeTarget) {
    return {
      command: process.execPath,
      argsPrefix: [nodeTarget.target],
      displayPath: cliPath,
      shell: false,
      env: nodeTarget.env,
    };
  }
  return {
    command: cliPath,
    argsPrefix: [],
    displayPath: cliPath,
    // Never route untrusted session/message arguments through a shell.
    shell: false,
  };
}

function resolveJavaScriptCliTarget(commandPath: string): string | undefined {
  if (!/\.(?:cjs|mjs|js)$/i.test(commandPath)) return undefined;
  try {
    if (!fs.statSync(commandPath).isFile()) return undefined;
    return path.resolve(commandPath);
  } catch {
    return undefined;
  }
}

const DEFAULT_GATEWAY =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";

export class OpenClawAdapter implements AgentAdapter {
  readonly adapterType = "openclaw" as AgentUnderTest["adapterType"];

  constructor(private readonly options: OpenClawAdapterOptions = {}) {}

  async createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession> {
    return new OpenClawSession(agent, config, this.options);
  }
}

export class OpenClawSession implements AgentSession {
  public readonly agent: AgentUnderTest;
  public readonly config: AgentAdapterConfig;
  private readonly gatewayUrl?: string;
  private readonly gatewayToken?: string;
  private readonly cliPath?: string;
  private readonly timeoutMs?: number;
  private readonly env?: Record<string, string | undefined>;
  private readonly signal?: AbortSignal;
  private readonly nativeGuardRequired: boolean;
  private readonly nativeGuardEventStore?: OpenClawAdapterOptions["nativeGuardEventStore"];
  private readonly guardLease?: OpenClawAdapterOptions["guardLease"];
  private sandboxTools: { toolId: string; toolName?: string; description?: string }[] = [];
  private sandboxResources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[] = [];
  private lastRunMeta?: import("./agentAdapter").AgentRunMeta;
  private lastRuntimeSessionKey?: string;
  private activatedLeaseId?: string;
  private lastActivatedLease?: { leaseId: string; leaseEpoch: number };
  private lastReconciliation?: NativeGuardReconciliationSummary;
  private lastRevokeError?: string;

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    options: OpenClawAdapterOptions,
  ) {
    this.agent = agent;
    this.config = config;
    this.gatewayUrl = options.gatewayUrl ?? (options.nativeGuardRequired ? DEFAULT_GATEWAY : undefined);
    this.gatewayToken = options.gatewayToken;
    this.cliPath = options.cliPath;
    this.timeoutMs = options.timeoutMs;
    this.env = options.env;
    this.signal = options.signal;
    this.nativeGuardRequired = options.nativeGuardRequired ?? false;
    this.nativeGuardEventStore = options.nativeGuardEventStore;
    this.guardLease = options.guardLease;
  }

  setSandboxContext(ctx: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  }): void {
    this.sandboxTools = ctx.tools;
    this.sandboxResources = ctx.resources;
  }

  async sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult> {
    this.lastRunMeta = undefined;
    this.lastRuntimeSessionKey = undefined;
    this.lastActivatedLease = undefined;
    this.lastReconciliation = undefined;
    this.lastRevokeError = undefined;

    const startedAt = nowIso();
    const runId = runMeta?.runId ?? "unknown";
    let runtimeSessionKey = runId;
    if (this.nativeGuardRequired) {
      try {
        runtimeSessionKey = canonicalizeOpenClawSessionKey(runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          schemaVersion: "mvp-1",
          runId,
          agentId: runMeta?.agentId ?? this.agent.agentId,
          caseId: runMeta?.caseId ?? task.caseId,
          status: "failed",
          error: message,
          finalMessage: `[OpenClaw Error] ${message}`,
          startedAt,
          endedAt: nowIso(),
        };
      }
    }

    // Activate native-guard lease for this session before tool execution.
    if (this.guardLease && this.nativeGuardRequired) {
      try {
        const lease = await this.guardLease.activate({
          rootSessionKey: runtimeSessionKey,
          runGroupId: runId,
        });
        this.activatedLeaseId = lease.leaseId;
        this.lastActivatedLease = lease;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          schemaVersion: "mvp-1",
          runId,
          agentId: runMeta?.agentId ?? this.agent.agentId,
          caseId: runMeta?.caseId ?? task.caseId,
          status: "failed",
          error: `Native guard lease activation failed: ${message}`,
          finalMessage: `[OpenClaw Error] Native guard lease activation failed: ${message}`,
          startedAt,
          endedAt: nowIso(),
        };
      }
    }

    try {
      this.lastRunMeta = runMeta;
      this.lastRuntimeSessionKey = runtimeSessionKey;
      const result = await runOpenClawSession(
        task,
        bridge,
        {
          runId: runMeta?.runId ?? "unknown",
          caseId: runMeta?.caseId ?? task.caseId,
          agentId: runMeta?.agentId ?? this.agent.agentId,
        },
        { tools: this.sandboxTools, resources: this.sandboxResources },
        {
          cliPath: this.cliPath,
          timeoutMs: this.timeoutMs,
          env: this.env,
          signal: this.signal,
          gatewayUrl: this.gatewayUrl,
          gatewayToken: this.gatewayToken,
          nativeGuardRequired: this.nativeGuardRequired,
          runtimeSessionKey,
          nativeGuardEventStore: this.nativeGuardEventStore,
        },
      );

      this.lastReconciliation = result.reconciliation;
      const endedAt = nowIso();
      // Coverage breach or mismatch: JSONL has tool calls the Hook
      // didn't see, or duplicate outcomes were detected.
      if (
        this.nativeGuardRequired &&
        result.reconciliation &&
        !result.reconciliation.reconciled
      ) {
        const count = result.reconciliation.coverageBreachCount;
        this.lastReconciliation = result.reconciliation;
        const breachMsg = count > 0
          ? `NATIVE_GUARD_COVERAGE_BREACH: ${String(count)} JSONL tool call(s) missing Hook before event.`
          : `NATIVE_GUARD_COVERAGE_BREACH: reconciliation mismatch (duplicate outcome or inconsistent state).`;
        return {
          schemaVersion: "mvp-1",
          runId: runMeta?.runId ?? "unknown",
          agentId: runMeta?.agentId ?? this.agent.agentId,
          caseId: runMeta?.caseId ?? task.caseId,
          status: "failed",
          error: breachMsg,
          finalMessage: `[OpenClaw Error] ${breachMsg}`,
          startedAt,
          endedAt,
        };
      }
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "completed",
        finalMessage: result.session.finalAnswer,
        startedAt,
        endedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "failed",
        error: message,
        finalMessage: `[OpenClaw Error] ${message}`,
        startedAt,
        endedAt: nowIso(),
      };
    } finally {
      if (this.guardLease && this.activatedLeaseId) {
        try {
          await this.guardLease.revoke(this.activatedLeaseId);
        } catch (revokeError) {
          this.lastRevokeError = revokeError instanceof Error
            ? revokeError.message
            : String(revokeError);
        } finally {
          this.activatedLeaseId = undefined;
        }
      }
    }
  }

  async close(): Promise<void> {}

  /** Task 12: Drain runtime evidence from the native guard event store. */
  async drainRuntimeEvidence(): Promise<AgentNativeGuardRuntimeEvidence> {
    if (!this.nativeGuardRequired) {
      return { nativeGuardEvents: [], supervisionRecords: [] };
    }
    if (!this.nativeGuardEventStore || !this.lastRunMeta || !this.lastRuntimeSessionKey) {
      if (this.nativeGuardRequired) {
        throw new Error(
          "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: runtime event store or run metadata is missing.",
        );
      }
      return { nativeGuardEvents: [], supervisionRecords: [] };
    }
    const revokeError = this.lastRevokeError;
    this.lastRevokeError = undefined;
    const identity = {
      sessionKey: this.lastRuntimeSessionKey,
      leaseId: this.lastActivatedLease?.leaseId,
      leaseEpoch: this.lastActivatedLease?.leaseEpoch,
    };
    try {
      const evidence = await drainOpenClawRuntimeEvidence(
        this.nativeGuardEventStore,
        this.lastRuntimeSessionKey,
        this.nativeGuardRequired,
      );
      return {
        ...identity,
        ...evidence,
        reconciliation: this.lastReconciliation,
        revokeError,
      };
    } catch (error) {
      return {
        ...identity,
        nativeGuardEvents: [],
        supervisionRecords: [],
        reconciliation: this.lastReconciliation,
        revokeError,
        evidenceError: scrubSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }
}

/** 检测 OpenClaw CLI 是否可用 */
export async function checkOpenClawAvailable(cliPath?: string): Promise<{
  available: boolean; version?: string; error?: string;
}> {
  const cli = resolveOpenClawCliInvocation(cliPath);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cli.command, [...cli.argsPrefix, "--version"], {
      windowsHide: true,
      shell: cli.shell,
      env: buildOpenClawProcessEnv(cli.env),
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        resolve({ available: false, error: "CLI version check timed out." });
      }
    }, 10_000);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 256 * 1024) child.kill();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > 256 * 1024) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ available: false, error: `CLI not available: ${error.message.slice(0, 100)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const version = stdout.trim();
      if (code === 0 && version) {
        resolve({ available: true, version });
      } else {
        resolve({
          available: false,
          error: stderr.trim() ? stderr.trim().slice(0, 160) : "Empty output",
        });
      }
    });
  });
}

function resolveWindowsNpmShimTarget(commandPath: string): {
  target: string;
  env?: Record<string, string>;
} | undefined {
  if (process.platform !== "win32" || !/\.cmd$/i.test(commandPath)) {
    return undefined;
  }
  const baseDir = path.dirname(commandPath);
  const parentDir = path.dirname(baseDir);
  const candidateTargets = [
    {
      target: path.join(baseDir, "node_modules", "openclaw", "openclaw.mjs"),
      env: resolveOpenClawLocalEnv(
        path.basename(baseDir).toLowerCase() === "cli" ? parentDir : baseDir,
      ),
    },
    {
      target: path.join(baseDir, "cli", "node_modules", "openclaw", "openclaw.mjs"),
      env: resolveOpenClawLocalEnv(baseDir),
    },
  ];
  return candidateTargets.find((candidate) => fs.existsSync(candidate.target));
}

function resolveControlledWindowsCmdTarget(commandPath: string): {
  target: string;
  env?: Record<string, string>;
} | undefined {
  if (process.platform !== "win32" || !/\.cmd$/i.test(commandPath)) {
    return undefined;
  }

  try {
    const lines = fs.readFileSync(commandPath, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines[0]?.toLowerCase() === "@echo off") lines.shift();
    if (lines.length !== 1) return undefined;
    const match = lines[0].match(
      /^node(?:\.exe)?\s+"%~dp0([^"%]+\.(?:cjs|mjs|js))"\s+%\*$/i,
    );
    if (!match) return undefined;

    const wrapperDir = fs.realpathSync(path.dirname(commandPath));
    const target = fs.realpathSync(path.resolve(wrapperDir, match[1]));
    const relativeTarget = path.relative(wrapperDir, target);
    if (
      relativeTarget === "" ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      return undefined;
    }
    return {
      target,
      env: resolveOpenClawLocalEnv(wrapperDir),
    };
  } catch {
    return undefined;
  }
}

function resolveOpenClawLocalEnv(rootDir: string): Record<string, string> | undefined {
  const configDir = path.join(rootDir, "config");
  const configPath = path.join(configDir, "openclaw.json");
  const homeDir = path.join(rootDir, "home");
  const homeConfigPath = path.join(homeDir, ".openclaw", "openclaw.json");
  if (!fs.existsSync(configPath) && !fs.existsSync(homeConfigPath)) return undefined;
  return {
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_CONFIG_PATH: fs.existsSync(configPath) ? configPath : homeConfigPath,
    OPENCLAW_CONFIG_DIR: fs.existsSync(configPath) ? configDir : path.dirname(homeConfigPath),
    OPENCLAW_HOME: fs.existsSync(homeConfigPath) ? homeDir : rootDir,
    OPENCLAW_WORKSPACE: path.join(rootDir, "workspace"),
  };
}

function resolveCommandPath(commandPath: string): string {
  if (process.platform !== "win32") return commandPath;
  if (path.isAbsolute(commandPath) || commandPath.includes("\\") || commandPath.includes("/")) {
    return commandPath;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const pathExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.toLowerCase());
  const hasExtension = path.extname(commandPath).length > 0;
  const candidates = hasExtension
    ? [commandPath]
    : [...pathExts.map((ext) => `${commandPath}${ext}`), commandPath];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }

  return commandPath;
}
