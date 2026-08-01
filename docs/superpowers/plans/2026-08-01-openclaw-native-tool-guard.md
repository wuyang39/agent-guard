# OpenClaw Native Tool Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OpenClaw 原生工具增加租约控制的执行前裁决，并让检测任务强制运行于可证明的 Docker 隔离环境，同时保证未启用 Agent Guard 的会话保持原有行为。

**Architecture:** Agent Guard 后端作为 PDP，OpenClaw 插件作为 PEP。插件用 Trusted Tool Policy 处理租约准入和 recovery，用低优先级 `before_tool_call` 对最终可见参数请求裁决，用 `after_tool_call` 上报真实结果；检测编排使用独立 OpenClaw Gateway/profile 和 Docker sandbox。正式 Trace 来自 Hook 事件，OpenClaw JSONL 只做交叉校验。

**Tech Stack:** TypeScript 5.9、Node.js 24.14+、Fastify 5、React 19、OpenClaw Plugin SDK 2026.7.2、Docker、Node test runner、esbuild、Ed25519/SHA-256。

---

## Baseline And Constraints

- 设计规格：`docs/superpowers/specs/2026-08-01-openclaw-native-tool-guard-design.md`。
- 当前本机 OpenClaw 为 `2026.6.1 (2e08f0f)`。
- 2026-08-01 可从 npm 获取的 `2026.7.1-2` 仍不包含 `registerTrustedToolPolicy`、`contracts.trustedToolPolicies` 和新版 `requireApproval` 契约。
- 开发契约固定到 OpenClaw `2026.7.2` / `3edbe19fbd84ba58fdbf8e83042da9efd1d06f81`。
- 在兼容 OpenClaw 不可用时，必须完成编译、单元测试和 fake-host 契约测试；真实 guarded 模式必须报告 `unsupported`，OFF 模式仍正常工作。
- 不恢复或提交工作区中已删除的 `docs/p4-native-tool-bypass-defense-plan.md`。
- 不把历史提交 `8aa25d9` 的插件直接恢复；只可参考其安装路径和事件展示方式。

**Scope check:** 共享协议、PDP、插件、检测 runtime、证据和状态 UI 是同一执行链，不能作为互不依赖的功能分别交付。每个 Task 仍须保持主仓库可编译：Task 1-6 只增加后端基础且不启用 Hook，Task 7-10 交付默认 OFF 的插件，Task 11-12 接通检测和证据，Task 13-14 才开放产品控制与完整验收。

## File Map

### Shared Protocol

- Create: `packages/contracts/src/types/nativeGuard.ts` — 前后端和插件共享的 wire types。
- Modify: `packages/contracts/src/index.ts` — 导出 native guard types。
- Create: `packages/native-guard-protocol/package.json` — 可独立打包的协议运行时代码。
- Create: `packages/native-guard-protocol/src/index.ts` — canonical JSON、摘要和 Ed25519 工具。
- Create: `packages/native-guard-protocol/src/index.test.ts` — 协议确定性和签名测试。
- Modify: `tsconfig.json` — 增加协议包路径和 include。

### Backend

- Create: `backend/src/modules/policy/policyPackRepository.ts` — 统一加载已生成的 OpenClaw 策略包。
- Modify: `backend/src/modules/supervisor/policyEngine.ts` — 安全正则门禁。
- Create: `backend/src/modules/openclaw/nativeGuardLeaseService.ts` — 租约、凭据哈希、签名密钥和会话树。
- Create: `backend/src/modules/openclaw/nativeToolDecisionService.ts` — 工具归一化、策略匹配和决策签名。
- Create: `backend/src/storage/nativeGuardEventStore.ts` — 事件、监督记录和 run 级查询。
- Create: `backend/src/modules/openclaw/openclawControlClient.ts` — 调用插件控制 route。
- Create: `backend/src/modules/openclaw/nativeGuardCoordinator.ts` — 后端租约与插件租约的原子编排。
- Create: `backend/src/api/v1/openclaw/native-guard-handlers.ts` — 管理、decision、event 和 status API。
- Create: `backend/src/api/v1/openclaw/native-guard-handlers.test.ts` — Fastify 鉴权和 API 测试。
- Modify: `backend/src/app.ts` — 注册 native guard routes 和受限 CORS。
- Modify: `backend/src/api/v1/system/handlers.ts` — 暴露覆盖状态。
- Modify: `backend/src/modules/openclaw/realtimeMcpServer.ts` — 复用策略仓库并发布 native 事件。

### OpenClaw Plugin

- Create: `plugins/agent-guard-supervision/openclaw.plugin.json` — manifest 和 trusted policy contract。
- Create: `plugins/agent-guard-supervision/package.json` — 插件包和兼容版本门禁。
- Create: `plugins/agent-guard-supervision/tsconfig.json` — 插件独立类型检查。
- Create: `plugins/agent-guard-supervision/src/openclaw-sdk.d.ts` — 2026.7.2 最小 SDK 契约快照。
- Create: `plugins/agent-guard-supervision/src/index.ts` — OpenClaw 注册入口。
- Create: `plugins/agent-guard-supervision/src/runtime.ts` — 可注入依赖的插件运行时。
- Create: `plugins/agent-guard-supervision/src/leaseRegistry.ts` — 内存租约和 recovery marker。
- Create: `plugins/agent-guard-supervision/src/controlRoutes.ts` — gateway-authenticated 激活、续租、撤销和状态 route。
- Create: `plugins/agent-guard-supervision/src/decisionClient.ts` — PDP 请求、超时和签名验证。
- Create: `plugins/agent-guard-supervision/src/toolRisk.ts` — 本地故障风险分类。
- Create: `plugins/agent-guard-supervision/src/eventSpool.ts` — 有界、原子、本地事件队列。
- Create: `plugins/agent-guard-supervision/src/*.test.ts` — OFF、租约、Hook、审批、子 Agent 和 spool 测试。

### Detection And Evidence

- Create: `backend/src/modules/openclaw/detectionOpenClawConfig.ts` — 独立 profile 安全配置生成。
- Create: `backend/src/modules/openclaw/detectionSandboxManager.ts` — Docker/Gateway 生命周期和 attestation。
- Create: `backend/src/modules/openclaw/nativeGuardTraceProjector.ts` — Hook 事件投影和 JSONL reconciliation。
- Modify: `backend/src/modules/agent/agentAdapter.ts` — 增加 runtime evidence drain 接口。
- Modify: `backend/src/modules/agent/openclawAdapter.ts` — 接收隔离 runtime 和 native guard coordinator。
- Modify: `backend/src/modules/agent/openclawSession.ts` — 去掉事后回放，收集真实 Hook 证据。
- Modify: `backend/src/modules/runner/testRunner.ts` — 将真实 Hook 证据写入 Trace。
- Modify: `backend/src/services/e2eRunService.ts` — OpenClaw 检测 runtime 的 start/finally stop。
- Modify: `backend/src/api/types.ts` — run group 增加 sandbox/guard evidence 摘要。

### Frontend And Operations

- Modify: `frontend/src/lib/api/types.ts` — native guard 状态、租约和事件类型。
- Create: `frontend/src/lib/api/nativeGuard.ts` — native guard API client。
- Modify: `frontend/src/lib/api/core.ts` — 管理请求控制令牌支持。
- Modify: `frontend/src/pages/System/SystemPage.tsx` — 覆盖状态。
- Modify: `frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx` — Docker preflight/attestation。
- Modify: `frontend/src/pages/Supervision/LiveSupervisionPage.tsx` — session lease 控制和 native 事件。
- Modify: `frontend/src/styles/app.css` — 状态条和紧凑控制布局。
- Modify: `desktop/main.cjs` — 每次启动生成控制令牌并注入 API 请求。
- Create: `scripts/install-openclaw-native-guard.ps1` — 构建、安装和能力检查。
- Create: `scripts/verify-openclaw-native-guard.ts` — fake/live 综合验证。
- Create: `scripts/verify-openclaw-detection-sandbox.ts` — Docker live 验证。
- Modify: `package.json` / `package-lock.json` — 构建、测试和验证命令。
- Modify: `docs/C/openclaw-local-install-and-demo-runbook.md` — 安装、升级、回滚和故障说明。

---

### Task 1: Shared Wire Contract And Signed Protocol

**Files:**
- Create: `packages/contracts/src/types/nativeGuard.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/native-guard-protocol/package.json`
- Create: `packages/native-guard-protocol/src/index.ts`
- Create: `packages/native-guard-protocol/src/index.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

- [ ] **Step 1: Write failing protocol tests**

```typescript
// packages/native-guard-protocol/src/index.test.ts
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  digestJson,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "./index";

test("canonical JSON is stable across key order", () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: true, a: "x" } }),
    canonicalJson({ nested: { a: "x", b: true }, z: 1 }),
  );
  assert.equal(
    digestJson({ z: 1, nested: { b: true, a: "x" } }),
    digestJson({ nested: { a: "x", b: true }, z: 1 }),
  );
});

test("Ed25519 signature rejects changed payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = { requestId: "req.1", action: "allow" };
  const signature = signNativeGuardPayload(payload, privateKey);
  assert.equal(verifyNativeGuardPayload(payload, signature, publicKey), true);
  assert.equal(
    verifyNativeGuardPayload({ ...payload, action: "deny" }, signature, publicKey),
    false,
  );
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --import tsx --test packages/native-guard-protocol/src/index.test.ts`

Expected: FAIL with `Cannot find module './index'`.

- [ ] **Step 3: Add the exact wire types**

```typescript
// packages/contracts/src/types/nativeGuard.ts
export type NativeGuardMode = "detection" | "supervision";
export type NativeGuardCoverageStatus =
  | "off"
  | "ready"
  | "active"
  | "recovery"
  | "conditional"
  | "unsupported"
  | "misconfigured";

export type NativeGuardAction = "allow" | "warn" | "deny" | "ask" | "redact";

export type NativeGuardLeaseActivation = {
  schemaVersion: "native-guard-1";
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  mode: NativeGuardMode;
  scope: "session_tree";
  policyPackId: string;
  policyPackDigest: string;
  backendUrl: string;
  decisionPublicKey: string;
  failurePolicy: {
    lowRisk: "allow" | "warn";
    highRisk: "deny";
    unknownRisk: "deny";
  };
  issuedAt: string;
  expiresAt: string;
  credential: string;
};

export type NativeToolDecisionRequest = {
  schemaVersion: "native-guard-1";
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  toolKind?: string;
  toolInputKind?: string;
  providerId?: string;
  params: Record<string, unknown>;
  paramsDigest: string;
  derivedPaths?: string[];
  requestedAt: string;
};

export type NativeToolDecisionResponse = {
  schemaVersion: "native-guard-1";
  decisionId: string;
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  policyPackId: string;
  policyPackDigest: string;
  action: NativeGuardAction;
  reasonCode: string;
  reason: string;
  evaluatedParamsDigest: string;
  rewrittenParams?: Record<string, unknown>;
  rewrittenParamsDigest?: string;
  decidedAt: string;
  signature: string;
};

export type NativeGuardEvent = {
  schemaVersion: "native-guard-1";
  eventId: string;
  type:
    | "lease_activated"
    | "lease_renewed"
    | "lease_recovery"
    | "lease_revoked"
    | "decision"
    | "approval_requested"
    | "approval_resolved"
    | "tool_outcome"
    | "sandbox_attested"
    | "coverage_changed";
  leaseId: string;
  sessionKey: string;
  runId?: string;
  toolCallId?: string;
  decisionId?: string;
  timestamp: string;
  detail: Record<string, unknown>;
};

export type NativeGuardStatus = {
  coverage: NativeGuardCoverageStatus;
  finalizerAssurance: "isolated_profile" | "exclusive_before_hook" | "unverified";
  pluginVersion?: string;
  openclawVersion?: string;
  activeLeaseCount: number;
  conflictingPluginIds?: string[];
  activeLease?: {
    leaseId: string;
    rootSessionKey: string;
    mode: NativeGuardMode;
    policyPackId: string;
    expiresAt: string;
  };
  reasonCode?: string;
  detail?: string;
};

export type OpenClawSandboxEvidence = {
  schemaVersion: "native-guard-1";
  runGroupId: string;
  sessionKey?: string;
  status: "preflight_passed" | "attested" | "failed" | "cleaned";
  openclawVersion: string;
  imageId: string;
  containerId?: string;
  networkMode: string;
  readOnlyRoot: boolean;
  workspaceAccess: "none" | "ro" | "rw";
  capDrop: string[];
  pidsLimit: number;
  memory: string | number;
  cpus: number;
  configDigest: string;
  checkedAt: string;
  failureReason?: string;
};
```

Append `export * from "./types/nativeGuard";` to `packages/contracts/src/index.ts`.

- [ ] **Step 4: Implement canonical JSON and signing**

```typescript
// packages/native-guard-protocol/src/index.ts
import {
  createHash,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not valid JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function signNativeGuardPayload(value: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(value)), privateKey).toString("base64url");
}

export function verifyNativeGuardPayload(
  value: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
```

Create `packages/native-guard-protocol/package.json` with name `@agent-guard/native-guard-protocol`, type `module`, and export `./src/index.ts`. Add the package path to both `tsconfig.json` paths and include lists.

- [ ] **Step 5: Add the protocol test command and run it**

Add to `package.json`:

```json
"test:native-guard:protocol": "node --import tsx --test packages/native-guard-protocol/src/index.test.ts"
```

Run: `npm run test:native-guard:protocol && npm run typecheck`

Expected: protocol tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/contracts packages/native-guard-protocol tsconfig.json
git commit -m "feat: add native guard signed protocol"
```

---

### Task 2: Policy Pack Repository And Safe Matchers

**Files:**
- Create: `backend/src/modules/policy/policyPackRepository.ts`
- Create: `backend/src/modules/policy/policyPackRepository.test.ts`
- Create: `backend/src/modules/supervisor/policyEngine.test.ts`
- Modify: `backend/src/modules/supervisor/policyEngine.ts`
- Modify: `backend/src/modules/openclaw/realtimeMcpServer.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing repository and unsafe-regex tests**

```typescript
// backend/src/modules/supervisor/policyEngine.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { findMatchingPolicies } from "./policyEngine";

test("unsafe nested-quantifier regex never matches", () => {
  const policies = findMatchingPolicies(
    {
      schemaVersion: "mvp-1",
      policyPackId: "pack.1",
      agentId: "agent.1",
      sourceDetectionReportId: "detection.1",
      sourceRiskProfileId: "profile.1",
      defaultAction: "allow",
      createdAt: new Date().toISOString(),
      policies: [{
        policyId: "policy.unsafe",
        sourceWeaknessIds: [],
        name: "unsafe",
        description: "unsafe regex",
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: {
          relation: "all",
          matchers: [{ fieldPath: "payload.parameters.value", operator: "regex", value: "(a+)+$" }],
        },
        reason: "unsafe",
      }],
    },
    {
      runtimeSessionId: "session.1",
      agentId: "agent.1",
      targetType: "tool_call",
      payload: { toolId: "tool.test", parameters: { value: "a".repeat(2000) } },
    },
  );
  assert.deepEqual(policies, []);
});
```

Repository tests must create a temporary report index and assert that a stored OpenClaw policy pack loads, while an HTTP-sample policy pack is rejected.

- [ ] **Step 2: Run tests and verify failures**

Run: `node --import tsx --test backend/src/modules/supervisor/policyEngine.test.ts backend/src/modules/policy/policyPackRepository.test.ts`

Expected: FAIL because `safe-regex2` and `policyPackRepository` are absent.

- [ ] **Step 3: Add safe regex validation**

Install: `npm install safe-regex2@5.1.1`

Replace `matchesRegex` with:

```typescript
import safeRegex from "safe-regex2";

const MAX_POLICY_REGEX_LENGTH = 256;

function matchesRegex(actual: string, pattern: string): boolean {
  if (!pattern || pattern.length > MAX_POLICY_REGEX_LENGTH || !safeRegex(pattern)) {
    return false;
  }
  try {
    return new RegExp(pattern).test(actual.slice(0, 65_536));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Extract the stored policy loader**

```typescript
// backend/src/modules/policy/policyPackRepository.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { getReportEntry } from "../../storage/fileReportStore";
import { getRunGroup } from "../../storage/fileRunStore";
import { resolveInsideDirectory } from "../../storage/pathSafety";

const REPORTS_DIR = path.resolve(process.cwd(), "outputs", "reports");

export async function loadStoredOpenClawPolicyPack(policyPackId: string): Promise<{
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
} | undefined> {
  const entry = await getReportEntry(policyPackId);
  if (!entry || entry.reportType !== "policy_pack") return undefined;
  const runGroup = await getRunGroup(entry.runGroupId);
  if (!runGroup || runGroup.adapterKind !== "openclaw") return undefined;
  if (runGroup.policyContextSource && runGroup.policyContextSource !== "stored_detection") {
    return undefined;
  }
  const filePath = path.join(
    resolveInsideDirectory(REPORTS_DIR, entry.runGroupId),
    "supervision-policy-pack.json",
  );
  const policyPack = JSON.parse(await fs.readFile(filePath, "utf8")) as SupervisionPolicyPack;
  if (policyPack.policyPackId !== policyPackId || policyPack.policies.length === 0) {
    return undefined;
  }
  return { policyPack, policyPackDigest: digestJson(policyPack), runGroupId: entry.runGroupId };
}
```

Update `realtimeMcpServer.ts` to call this repository instead of its private `loadOpenClawPolicyPackById` implementation.

- [ ] **Step 5: Run focused and existing realtime tests**

Run: `node --import tsx --test backend/src/modules/supervisor/policyEngine.test.ts backend/src/modules/policy/policyPackRepository.test.ts && npm run verify:openclaw:realtime`

Expected: all tests PASS and existing realtime MCP behavior remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json backend/src/modules/policy backend/src/modules/supervisor/policyEngine.ts backend/src/modules/supervisor/policyEngine.test.ts backend/src/modules/openclaw/realtimeMcpServer.ts
git commit -m "refactor: centralize guarded policy loading"
```

---

### Task 3: Lease Service And Recovery State

**Files:**
- Create: `backend/src/modules/openclaw/nativeGuardLeaseService.ts`
- Create: `backend/src/modules/openclaw/nativeGuardLeaseService.test.ts`

- [ ] **Step 1: Write failing lease lifecycle tests**

```typescript
// backend/src/modules/openclaw/nativeGuardLeaseService.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";

function policyPackFixture(): SupervisionPolicyPack {
  return {
    schemaVersion: "mvp-1",
    policyPackId: "pack.1",
    agentId: "agent.1",
    sourceDetectionReportId: "detection.1",
    sourceRiskProfileId: "profile.1",
    policies: [{
      policyId: "policy.allow",
      sourceWeaknessIds: [],
      name: "allow",
      description: "allow fixture",
      targetType: "tool_call",
      action: "allow",
      riskLevel: "low",
      match: { relation: "all", matchers: [] },
      reason: "allowed",
    }],
    defaultAction: "allow",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
  };
}

test("lease is session-bound, expiring, renewable and revocable", () => {
  let now = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => now });
  const created = service.create({
    rootSessionKey: "agent:guard:run.1",
    mode: "supervision",
    policyPack: policyPackFixture(),
    policyPackDigest: "digest.1",
    backendUrl: "http://127.0.0.1:3100",
    ttlMs: 300_000,
  });
  assert.equal(service.authenticate(created.activation.leaseId, created.activation.credential)?.state, "active");
  service.bindChild(created.activation.leaseId, "agent:guard:run.1", "agent:guard:child.1");
  assert.equal(service.resolveBySession("agent:guard:child.1")?.leaseId, created.activation.leaseId);
  now += 1_000;
  const renewed = service.renew(created.activation.leaseId, 300_000);
  assert.notEqual(renewed.credential, created.activation.credential);
  assert.equal(renewed.leaseEpoch, created.activation.leaseEpoch + 1);
  now += 300_001;
  assert.equal(service.resolveBySession("agent:guard:run.1"), undefined);
  service.revoke(created.activation.leaseId);
  assert.equal(service.authenticate(created.activation.leaseId, renewed.credential), undefined);
});
```

Include a second test proving wrong credentials, wrong sessions, TTL above 15 minutes and expired policy packs are rejected.

- [ ] **Step 2: Run the test and verify failure**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeGuardLeaseService.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the service**

The implementation must expose this exact public surface:

```typescript
export type NativeGuardLeaseService = {
  create(input: CreateLeaseInput): { activation: NativeGuardLeaseActivation; status: NativeGuardStatus };
  renew(leaseId: string, ttlMs?: number): NativeGuardLeaseActivation;
  revoke(leaseId: string): boolean;
  authenticate(leaseId: string, credential: string): ActiveNativeGuardLease | undefined;
  resolveBySession(sessionKey: string): ActiveNativeGuardLease | undefined;
  bindChild(leaseId: string, parentSessionKey: string, childSessionKey: string): boolean;
  endSession(sessionKey: string): void;
  signDecision(leaseId: string, response: Omit<NativeToolDecisionResponse, "signature">): string;
  status(): NativeGuardStatus;
};
```

Use `randomBytes(32)`, `timingSafeEqual`, `generateKeyPairSync("ed25519")`, a SHA-256 credential hash, a 5-minute default TTL and a 15-minute maximum. Start at `leaseEpoch=1`; increment it before every renew and revoke so old in-flight responses cannot be accepted. Include the immutable failure policy `{ lowRisk: "warn", highRisk: "deny", unknownRisk: "deny" }` in activation. Store the private key and policy pack only in memory. Never include `credential`, private key or full policy pack in `status()`.

- [ ] **Step 4: Run lease tests and typecheck**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeGuardLeaseService.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/openclaw
git commit -m "feat: add session scoped native guard leases"
```

---

### Task 4: Native Tool Decision Service And Event Store

**Files:**
- Create: `backend/src/modules/openclaw/nativeToolDecisionService.ts`
- Create: `backend/src/modules/openclaw/nativeToolDecisionService.test.ts`
- Create: `backend/src/storage/nativeGuardEventStore.ts`
- Create: `backend/src/storage/nativeGuardEventStore.test.ts`
- Modify: `backend/src/modules/supervisor/supervisionRecorder.ts`

- [ ] **Step 1: Write failing allow/deny/ask/redact tests**

```typescript
test("decision service signs a nested redact bound to input digest", async () => {
  const policyPack = buildRedactPolicyPackFixture("payload.parameters.request.body");
  const leaseService = createNativeGuardLeaseService({
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const created = leaseService.create({
    rootSessionKey: "agent:guard:run.1",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:3100",
    ttlMs: 300_000,
  });
  const eventStore = createNativeGuardEventStore({
    rootDir: await mkdtemp(path.join(tmpdir(), "native-guard-decision-")),
  });
  const service = createNativeToolDecisionService({
    leaseService,
    eventStore,
    now: () => "2026-08-01T00:00:01.000Z",
  });
  const result = await service.decide({
    schemaVersion: "native-guard-1",
    requestId: "req.1",
    leaseId: created.activation.leaseId,
    leaseEpoch: created.activation.leaseEpoch,
    sessionKey: "agent:guard:run.1",
    runId: "run.1",
    toolCallId: "call.1",
    toolName: "web_fetch",
    params: { request: { body: "token=secret" } },
    paramsDigest: digestJson({ request: { body: "token=secret" } }),
    requestedAt: "2026-08-01T00:00:00.500Z",
  }, created.activation.credential);
  assert.equal(result.response.action, "redact");
  assert.deepEqual(result.response.rewrittenParams, {
    request: { body: "[REDACTED]" },
  });
  assert.equal(result.record.inputEventId, "req.1");
});
```

Add tests for deny priority, ask priority, unmatched default allow, unknown tool outage classification, stale request time, request digest mismatch, same-request replay and epoch changes. The same `requestId` plus the same digest must return the same `decisionId`; the same `requestId` with another digest must fail.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeToolDecisionService.test.ts backend/src/storage/nativeGuardEventStore.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement deterministic normalization and decisions**

```typescript
export type NativeToolDecisionService = {
  decide(
    request: NativeToolDecisionRequest,
    credential: string,
  ): Promise<{
    response: NativeToolDecisionResponse;
    record: RuntimeSupervisionRecord;
  }>;
};

const ACTION_PRIORITY: Record<NativeGuardAction, number> = {
  deny: 5,
  ask: 4,
  redact: 3,
  warn: 2,
  allow: 1,
};
```

The normalizer must map `exec`/`process` to `code_execution`, write/edit/apply_patch to `file_write`, network/browser tools to `api_call`, and everything else to `tool_call`. Unknown tools remain `tool_call` but receive the local `unknown_side_effect` risk tag. Runtime policy evaluation must not call an LLM.

For redact, deep-clone `params`, translate `payload.parameters.*` matcher paths to nested parameter paths, and replace the exact matched string with `[REDACTED]`. Return the full rewritten object and its digest. Reject a decision that attempts to combine ask with rewritten params. Cache request digest and signed response until lease expiry. Re-read the lease epoch immediately before signing; if renew or revoke changed it while evaluation was in flight, return `NATIVE_GUARD_LEASE_CHANGED` instead of an allow/redact/ask response.

- [ ] **Step 4: Implement durable event ingestion**

`NativeGuardEventStore` must:

```typescript
export type NativeGuardEventStore = {
  append(event: NativeGuardEvent, record?: RuntimeSupervisionRecord): Promise<boolean>;
  listByRun(runId: string): Promise<NativeGuardEvent[]>;
  listRecordsByRun(runId: string): Promise<RuntimeSupervisionRecord[]>;
  listBySession(sessionKey: string): Promise<NativeGuardEvent[]>;
  subscribe(listener: (event: NativeGuardEvent) => void): () => void;
};
```

Persist JSONL under `outputs/native-guard/events/<leaseId>.jsonl`, serialize writes through `Mutex`, reject duplicate `eventId`, and never persist credentials, authorization headers or private keys.

- [ ] **Step 5: Run focused tests**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeToolDecisionService.test.ts backend/src/storage/nativeGuardEventStore.test.ts`

Expected: all action, digest, signature and idempotency tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/openclaw backend/src/modules/supervisor/supervisionRecorder.ts backend/src/storage/nativeGuardEventStore*
git commit -m "feat: evaluate and persist native tool decisions"
```

---

### Task 5: OpenClaw Control Client And Atomic Coordinator

**Files:**
- Create: `backend/src/modules/openclaw/openclawControlClient.ts`
- Create: `backend/src/modules/openclaw/openclawControlClient.test.ts`
- Create: `backend/src/modules/openclaw/nativeGuardCoordinator.ts`
- Create: `backend/src/modules/openclaw/nativeGuardCoordinator.test.ts`

- [ ] **Step 1: Write failing URL, auth and rollback tests**

Tests must prove:

```typescript
let capturedHeaders = new Headers();
let capturedRedirectMode: RequestRedirect | undefined;
const client = createOpenClawControlClient({
  gatewayToken: "gateway-token",
  fetchImpl: async (_url, init) => {
    capturedHeaders = new Headers(init?.headers);
    capturedRedirectMode = init?.redirect;
    return new Response(JSON.stringify({ coverage: "ready", activeLeaseCount: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
await assert.rejects(
  () => client.activate("http://192.168.1.8:18789", activationFixture()),
  /loopback/,
);
await client.status("http://127.0.0.1:18789");
assert.equal(capturedHeaders.get("authorization"), "Bearer gateway-token");
assert.equal(capturedRedirectMode, "error");
```

Coordinator tests must prove a backend lease is revoked if plugin activation fails, renew changes the credential, and revoke is idempotent even if the plugin is already offline. Add a CLI fixture where an enabled second plugin reports `hookNames: ["before_tool_call"]`; activation must fail with `NATIVE_GUARD_HOOK_ORDER_UNVERIFIED` and status must be `conditional`.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test backend/src/modules/openclaw/openclawControlClient.test.ts backend/src/modules/openclaw/nativeGuardCoordinator.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the control client**

```typescript
export type OpenClawControlClient = {
  status(gatewayUrl: string): Promise<NativeGuardStatus>;
  inspectCapabilities(input: {
    cliPath?: string;
    env?: Record<string, string>;
    isolatedProfile: boolean;
  }): Promise<{
    openclawVersion: string;
    supportsNativeGuard: boolean;
    finalizerAssurance: "isolated_profile" | "exclusive_before_hook" | "unverified";
    conflictingPluginIds: string[];
  }>;
  activate(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  renew(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  revoke(gatewayUrl: string, leaseId: string): Promise<NativeGuardStatus>;
};
```

Convert `ws://`/`wss://` gateway URLs to `http://`/`https://`, require loopback in v1, use `OPENCLAW_GATEWAY_TOKEN`, `redirect: "error"`, a 2-second timeout and a 64 KiB response limit. Never include the token in URL or error messages.

`inspectCapabilities` must run `openclaw --version` and `openclaw plugins list --json` through the existing safe CLI resolver. For normal supervision, any enabled plugin other than Agent Guard whose `hookNames` contains `before_tool_call` makes assurance `unverified` and coverage `conditional`. For the generated detection profile, the exact plugin allowlist makes assurance `isolated_profile`. A compatible normal profile with Agent Guard as the only before-tool Hook uses `exclusive_before_hook`.

- [ ] **Step 4: Implement coordinator ordering**

Activation order:

```text
load exact stored policy -> create backend lease -> activate plugin
plugin failure -> revoke backend lease -> return NATIVE_GUARD_ACTIVATION_FAILED
```

Run capability and Hook-order preflight before creating the backend lease. Version or Trusted Policy incompatibility returns `unsupported`; an unverified later parameter mutator returns `conditional` and does not activate a lease in v1.

Revoke order:

```text
mark backend lease revoking -> ask plugin to revoke -> delete backend lease
plugin failure still deletes backend secret and returns a warning status
```

Include `createDetectionBaselinePolicyPack()` with a fixed ID and digest. It allows sandboxed file/shell intent observation and denies browser, elevated/host control, gateway mutation, cron, cross-session send and unknown plugin surfaces during detection.

- [ ] **Step 5: Run tests**

Run: `node --import tsx --test backend/src/modules/openclaw/openclawControlClient.test.ts backend/src/modules/openclaw/nativeGuardCoordinator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/openclaw
git commit -m "feat: coordinate OpenClaw native guard leases"
```

---

### Task 6: Authenticated Native Guard API And Desktop Control Token

**Files:**
- Create: `backend/src/api/v1/openclaw/native-guard-handlers.ts`
- Create: `backend/src/api/v1/openclaw/native-guard-handlers.test.ts`
- Create: `backend/src/modules/openclaw/nativeGuardAuth.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/api/v1/system/handlers.ts`
- Modify: `desktop/main.cjs`

- [ ] **Step 1: Write failing API auth tests**

```typescript
test("management endpoint rejects missing operator token", async () => {
  process.env.AGENT_GUARD_CONTROL_TOKEN = "operator-secret";
  const app = await buildApp({ logger: false });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/leases",
    payload: { rootSessionKey: "agent:guard:run.1", mode: "supervision", policyPackId: "pack.1" },
  });
  assert.equal(response.statusCode, 401);
});

test("decision endpoint rejects operator token and accepts only lease bearer", async () => {
  // Create a lease fixture, then assert wrong/missing bearer = 401 and exact lease bearer = 200.
});
```

Add tests for unapproved Origin, body larger than 256 KiB, malformed decision payload and credential redaction in errors.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test backend/src/api/v1/openclaw/native-guard-handlers.test.ts`

Expected: FAIL with 404 or missing module.

- [ ] **Step 3: Add routes with separate auth domains**

Implement:

```text
GET    /api/v1/openclaw/native-guard/status
POST   /api/v1/openclaw/native-guard/leases
POST   /api/v1/openclaw/native-guard/leases/:leaseId/renew
DELETE /api/v1/openclaw/native-guard/leases/:leaseId
POST   /api/v1/openclaw/native-guard/decision
POST   /api/v1/openclaw/native-guard/events/batch
```

Management routes require `X-Agent-Guard-Control-Token`. Decision and event routes require the exact lease bearer. Apply JSON schema validation, 256 KiB decision body limit, 1 MiB event batch limit, maximum 100 events per batch and exact allowed Origins from `AGENT_GUARD_ALLOWED_ORIGINS` plus the local Electron/Vite defaults.

- [ ] **Step 4: Generate and inject the desktop token**

At desktop startup:

```javascript
const { randomBytes } = require("node:crypto");
const CONTROL_TOKEN = process.env.AGENT_GUARD_CONTROL_TOKEN || randomBytes(32).toString("base64url");
```

Pass `AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN` to the API child. Register an Electron `session.webRequest.onBeforeSendHeaders` filter for `${API_BASE}/*` and add `X-Agent-Guard-Control-Token` without exposing it to page JavaScript. In browser-only development, accept an explicitly configured `VITE_AGENT_GUARD_CONTROL_TOKEN`.

- [ ] **Step 5: Expose status without secrets**

Add `nativeGuard` to `/api/v1/system/status.health` and set feature flags `openclawNativeGuard`, `openclawNativeGuardReady`, and `openclawDetectionDocker`. Status may include coverage, compatible versions and active lease count, but not full session keys, credentials or policy content.

- [ ] **Step 6: Run API and desktop smoke tests**

Run: `node --import tsx --test backend/src/api/v1/openclaw/native-guard-handlers.test.ts && npm run typecheck && npm run build:frontend`

Expected: API tests PASS and both builds exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/v1/openclaw backend/src/modules/openclaw/nativeGuardAuth.ts backend/src/app.ts backend/src/api/v1/system/handlers.ts desktop/main.cjs
git commit -m "feat: secure native guard control APIs"
```

---

### Task 7: Plugin Package And Lease Registry

**Files:**
- Create: `plugins/agent-guard-supervision/openclaw.plugin.json`
- Create: `plugins/agent-guard-supervision/package.json`
- Create: `plugins/agent-guard-supervision/tsconfig.json`
- Create: `plugins/agent-guard-supervision/src/openclaw-sdk.d.ts`
- Create: `plugins/agent-guard-supervision/src/index.ts`
- Create: `plugins/agent-guard-supervision/src/runtime.ts`
- Create: `plugins/agent-guard-supervision/src/leaseRegistry.ts`
- Create: `plugins/agent-guard-supervision/src/leaseRegistry.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing OFF and recovery registry tests**

```typescript
test("missing lease is a zero-effect OFF lookup", async () => {
  const registry = createLeaseRegistry({ markerStore: memoryMarkerStore() });
  await registry.start();
  assert.deepEqual(registry.lookup("agent:main"), { state: "off" });
});

test("restart with an unexpired marker enters recovery", async () => {
  const future = "2026-08-01T00:10:00.000Z";
  const store = memoryMarkerStore([{ leaseId: "lease.1", rootSessionKey: "agent:guard:run.1", expiresAt: future }]);
  const registry = createLeaseRegistry({
    markerStore: store,
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  await registry.start();
  assert.equal(registry.lookup("agent:guard:run.1").state, "recovery");
});
```

Also test activation, rotation on renew, explicit revoke, expiry to OFF and child binding.

- [ ] **Step 2: Run plugin tests and verify failure**

Run: `node --import tsx --test plugins/agent-guard-supervision/src/leaseRegistry.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Add strict manifest and package compatibility**

```json
// plugins/agent-guard-supervision/openclaw.plugin.json
{
  "id": "agent-guard-supervision",
  "name": "Agent Guard Supervision",
  "description": "Lease-scoped native tool policy enforcement for Agent Guard.",
  "activation": { "onStartup": true },
  "contracts": { "trustedToolPolicies": ["agent-guard-admission"] },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "decisionTimeoutMs": { "type": "integer", "minimum": 100, "maximum": 10000 },
      "markerDir": { "type": "string" },
      "spoolDir": { "type": "string" }
    }
  }
}
```

Package metadata must declare `openclaw.extensions` and `runtimeExtensions` as `./dist/index.js`, `install.minHostVersion` and `compat.pluginApi` as `>=2026.7.2`, and an optional peer dependency `openclaw >=2026.7.2`.

Use this minimum SDK declaration snapshot so the plugin can typecheck before `2026.7.2` is published to npm:

```typescript
// plugins/agent-guard-supervision/src/openclaw-sdk.d.ts
declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export type ToolEvent = {
    toolName: string;
    params: Record<string, unknown>;
    toolKind?: "code_mode_exec";
    toolInputKind?: "javascript" | "typescript";
    runId?: string;
    toolCallId?: string;
    derivedPaths?: readonly string[];
    result?: unknown;
    error?: string;
    durationMs?: number;
  };
  export type ToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    abortSignal?: AbortSignal;
    toolName: string;
    toolKind?: "code_mode_exec";
    toolInputKind?: "javascript" | "typescript";
    toolCallId?: string;
  };
  export type BeforeResult = {
    params?: Record<string, unknown>;
    block?: boolean;
    blockReason?: string;
    requireApproval?: {
      title: string;
      description: string;
      severity?: "info" | "warning" | "critical";
      timeoutMs?: number;
      timeoutReason?: string;
      allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
      pluginId?: string;
      onResolution?: (
        decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
      ) => Promise<void> | void;
    };
  };
  export type PluginApi = {
    on(
      name: string,
      handler: (event: any, context: any) => Promise<any> | any,
      options?: { priority?: number; timeoutMs?: number },
    ): void;
    registerTrustedToolPolicy(policy: {
      id: string;
      description: string;
      evaluate(event: ToolEvent, context: ToolContext): Promise<BeforeResult | void> | BeforeResult | void;
    }): void;
    registerHttpRoute(route: {
      path: string;
      auth: "gateway" | "plugin";
      match?: "exact" | "prefix";
      handler(req: IncomingMessage, res: ServerResponse): Promise<boolean | void> | boolean | void;
    }): void;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
  };
  export function definePluginEntry(definition: {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }): unknown;
}
```

- [ ] **Step 4: Implement marker-safe lease registry**

Persist only:

```typescript
type GuardedMarker = {
  leaseId: string;
  rootSessionKey: string;
  childSessionKeys: string[];
  mode: "detection" | "supervision";
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
};
```

Write with temp-file plus atomic rename and mode `0o600`. Store activation credentials and public keys only in memory. `start()` loads markers, deletes expired entries and marks remaining entries recovery until reactivated.

- [ ] **Step 5: Add bundle and typecheck scripts**

Install: `npm install --save-dev esbuild@0.28.1`

Add:

```json
"build:openclaw-plugin": "esbuild plugins/agent-guard-supervision/src/index.ts --bundle --platform=node --format=esm --outfile=plugins/agent-guard-supervision/dist/index.js --external:openclaw/*",
"typecheck:openclaw-plugin": "tsc -p plugins/agent-guard-supervision/tsconfig.json --noEmit",
"test:native-guard:plugin": "node --import tsx --test plugins/agent-guard-supervision/src/leaseRegistry.test.ts"
```

Also add `packages/native-guard-protocol/**` and `plugins/agent-guard-supervision/**` to Electron Builder's `build.files`, so packaged desktop builds contain the protocol runtime and installable plugin bundle.

- [ ] **Step 6: Run tests and build**

Run: `npm run test:native-guard:plugin && npm run typecheck:openclaw-plugin && npm run build:openclaw-plugin`

Expected: tests PASS and `dist/index.js` is self-contained except for OpenClaw SDK imports.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json plugins/agent-guard-supervision
git commit -m "feat: scaffold trusted OpenClaw guard plugin"
```

---

### Task 8: Plugin Control Routes And Session Tree Lifecycle

**Files:**
- Create: `plugins/agent-guard-supervision/src/controlRoutes.ts`
- Create: `plugins/agent-guard-supervision/src/controlRoutes.test.ts`
- Modify: `plugins/agent-guard-supervision/src/runtime.ts`
- Modify: `plugins/agent-guard-supervision/src/index.ts`

- [ ] **Step 1: Write failing bounded-route tests**

Test activate, renew, revoke and status; reject bodies above 64 KiB, schema mismatch, non-loopback backend URL, expired activation and renew with a different root session.

```typescript
assert.equal(route.auth, "gateway");
assert.equal(route.match, "exact");
assert.equal(registry.lookup("agent:guard:run.1").state, "active");
assert.equal(JSON.stringify(statusBody).includes("credential"), false);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test plugins/agent-guard-supervision/src/controlRoutes.test.ts`

Expected: FAIL with missing route module.

- [ ] **Step 3: Register exact gateway-authenticated routes**

```text
POST /agent-guard/native-guard/v1/leases/activate
POST /agent-guard/native-guard/v1/leases/renew
POST /agent-guard/native-guard/v1/leases/revoke
GET  /agent-guard/native-guard/v1/status
```

Use `api.registerHttpRoute({ auth: "gateway", match: "exact", ... })`. Parse `IncomingMessage` with a 64 KiB limit, return JSON with `Cache-Control: no-store`, and never echo credentials.

- [ ] **Step 4: Wire session and subagent lifecycle hooks**

Register:

```typescript
api.on("subagent_spawned", async (event, ctx) => {
  if (ctx.requesterSessionKey) {
    await registry.bindChild(ctx.requesterSessionKey, event.childSessionKey);
  }
});
api.on("subagent_ended", async (event) => registry.endSession(event.targetSessionKey));
api.on("session_end", async (event, ctx) => {
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  if (sessionKey) await registry.endSession(sessionKey);
});
```

Gateway stop must flush marker writes and abort pending network operations within five seconds.

- [ ] **Step 5: Run plugin tests and build**

Update `test:native-guard:plugin` to include `controlRoutes.test.ts` after `leaseRegistry.test.ts`.

Run: `npm run test:native-guard:plugin && npm run typecheck:openclaw-plugin && npm run build:openclaw-plugin`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/agent-guard-supervision
git commit -m "feat: add guarded lease control routes"
```

---

### Task 9: Trusted Admission And Final Before-Tool Decision

**Files:**
- Create: `plugins/agent-guard-supervision/src/decisionClient.ts`
- Create: `plugins/agent-guard-supervision/src/toolRisk.ts`
- Create: `plugins/agent-guard-supervision/src/runtime.test.ts`
- Modify: `plugins/agent-guard-supervision/src/runtime.ts`
- Modify: `plugins/agent-guard-supervision/src/index.ts`

- [ ] **Step 1: Write failing behavioral tests**

Cover these exact cases:

```typescript
test("OFF returns without fetch, audit, logging or parameter changes", async () => {
  let fetchCalls = 0;
  const emittedEvents: unknown[] = [];
  const runtime = createRuntime({
    leaseRegistry: { lookup: () => ({ state: "off" }) },
    decisionClient: {
      decide: async () => {
        fetchCalls += 1;
        throw new Error("OFF must not call PDP");
      },
    },
    emitEvent: async (event) => { emittedEvents.push(event); },
  });
  const result = await runtime.beforeToolCall(
    { toolName: "exec", params: { command: "echo ok" }, toolCallId: "call.1" },
    { toolName: "exec", sessionKey: "agent:main", toolCallId: "call.1" },
  );
  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(emittedEvents, []);
});
```

Use the same dependency-injected harness for active cases and assert exact results:

```typescript
assert.deepEqual(denyResult, {
  block: true,
  blockReason: "[Agent Guard:NATIVE_POLICY_DENY] denied",
});
assert.deepEqual(redactResult, { params: { body: "[REDACTED]" } });
assert.deepEqual(askResult?.requireApproval?.allowedDecisions, ["allow-once", "deny"]);
```

Also test bad signature, mismatched digest, malformed response, timeout, cancellation, recovery, low-risk outage, high-risk outage and missing `toolCallId`.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test plugins/agent-guard-supervision/src/runtime.test.ts`

Expected: FAIL until hooks are implemented.

- [ ] **Step 3: Implement Trusted Admission Policy**

Register matcher-less policy ID `agent-guard-admission`:

```typescript
api.registerTrustedToolPolicy({
  id: "agent-guard-admission",
  description: "Enforces Agent Guard lease and recovery admission before tool execution.",
  evaluate: (event, ctx) => runtime.trustedAdmission(event, ctx),
});
```

OFF returns `undefined`. ACTIVE continues to final Hook. RECOVERY blocks high-risk and unknown tools with reason code `NATIVE_GUARD_RECOVERY`; only the explicit local low-risk set may pass. Missing session identity during an active guarded run fails closed.

- [ ] **Step 4: Implement the signed PDP client**

Use a two-second AbortController linked to `ctx.abortSignal`. Validate response schema, Ed25519 signature, request ID, lease ID, lease epoch, policy digest and both parameter digests. Do not follow redirects. Treat all validation failures as PDP outage and apply the immutable `failurePolicy` carried by the active lease.

- [ ] **Step 5: Implement the final `before_tool_call` Hook**

Register with priority `-1_000_000` and timeout `5_000`. Under ACTIVE, every tool produces one decision request. Map results exactly:

```text
allow -> undefined
warn -> undefined plus decision event
deny -> block + stable reason code
ask -> requireApproval with allow-once/deny and onResolution event
redact -> params only after signature and digest validation
```

Do not combine `params` and `requireApproval`. Do not keep name-prefix bypass lists. Never use `allow-always`.

- [ ] **Step 6: Run plugin behavioral tests**

Update `test:native-guard:plugin` to append `runtime.test.ts`.

Run: `npm run test:native-guard:plugin && npm run typecheck:openclaw-plugin && npm run build:openclaw-plugin`

Expected: OFF, deny, redact, ask, timeout and signature tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/agent-guard-supervision
git commit -m "feat: enforce signed native tool decisions"
```

---

### Task 10: Outcome Reporting And Bounded Spool

**Files:**
- Create: `plugins/agent-guard-supervision/src/eventSpool.ts`
- Create: `plugins/agent-guard-supervision/src/eventSpool.test.ts`
- Modify: `plugins/agent-guard-supervision/src/runtime.ts`
- Modify: `plugins/agent-guard-supervision/src/index.ts`

- [ ] **Step 1: Write failing spool and outcome tests**

Tests must verify:

- result preview truncates at 8 KiB;
- keys matching token, authorization, password, credential, cookie and secret are replaced with `[REDACTED]`;
- duplicate event IDs are sent once;
- a failed upload is persisted and retried;
- maximum is 10,000 events or 50 MiB;
- deny, approval and error events survive eviction before ordinary successful outcomes;
- after Hook for OFF produces zero events and zero filesystem writes.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test plugins/agent-guard-supervision/src/eventSpool.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement atomic spool**

Use one JSONL file plus an atomic metadata file under the configured spool directory. Serialize enqueue/ack/compact operations. Store only sanitized events. Retry batches of at most 100 with exponential delays capped at 30 seconds and stop all retries when the lease is revoked or Gateway stops.

- [ ] **Step 4: Register `after_tool_call`**

Build `tool_outcome` with `toolCallId`, run/session/lease IDs, final params digest, error, duration, result digest and sanitized preview. Upload asynchronously through the spool without changing the completed tool result.

- [ ] **Step 5: Run plugin tests and build**

Update `test:native-guard:plugin` to the final explicit list:

```json
"test:native-guard:plugin": "node --import tsx --test plugins/agent-guard-supervision/src/leaseRegistry.test.ts plugins/agent-guard-supervision/src/controlRoutes.test.ts plugins/agent-guard-supervision/src/runtime.test.ts plugins/agent-guard-supervision/src/eventSpool.test.ts"
```

Run: `npm run test:native-guard:plugin && npm run build:openclaw-plugin`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/agent-guard-supervision
git commit -m "feat: spool native tool outcome evidence"
```

---

### Task 11: Isolated OpenClaw Detection Runtime And Docker Attestation

**Files:**
- Create: `backend/src/modules/openclaw/detectionOpenClawConfig.ts`
- Create: `backend/src/modules/openclaw/detectionOpenClawConfig.test.ts`
- Create: `backend/src/modules/openclaw/detectionSandboxManager.ts`
- Create: `backend/src/modules/openclaw/detectionSandboxManager.test.ts`
- Modify: `backend/src/modules/agent/openclawAdapter.ts`
- Modify: `backend/src/modules/agent/openclawSession.ts`

- [ ] **Step 1: Write failing config and preflight tests**

Assert the generated runtime config contains:

```typescript
assert.equal(config.agents.defaults.sandbox.mode, "all");
assert.equal(config.agents.defaults.sandbox.scope, "session");
assert.equal(config.agents.defaults.sandbox.backend, "docker");
assert.equal(config.agents.defaults.sandbox.workspaceAccess, "ro");
assert.equal(config.agents.defaults.sandbox.docker.network, "none");
assert.equal(config.agents.defaults.sandbox.docker.readOnlyRoot, true);
assert.deepEqual(config.agents.defaults.sandbox.docker.capDrop, ["ALL"]);
assert.equal(config.tools.elevated.enabled, false);
assert.equal(config.agents.defaults.sandbox.browser.enabled, false);
assert.deepEqual(config.agents.defaults.sandbox.docker.binds, []);
```

Manager tests use an injected command runner and verify Docker unavailable, mutable image tag without resolved image ID, unsupported OpenClaw, bad `sandbox explain`, cancel and cleanup behavior.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --import tsx --test backend/src/modules/openclaw/detectionOpenClawConfig.test.ts backend/src/modules/openclaw/detectionSandboxManager.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Generate an isolated, scrubbed profile**

Runtime state lives in an OS temp directory with directory mode `0o700`. Persistent evidence lives under `outputs/openclaw-detection/<runGroupId>/` and contains only scrubbed config plus hashes.

Whitelist model/provider references from the user config, preserve SecretRefs, and reject inline secrets that cannot be represented without copying secret text. Never inherit user tools, plugins, workspace binds, browser or elevated settings.

Set Docker limits:

```json
{
  "user": "65532:65532",
  "pidsLimit": 128,
  "memory": "512m",
  "memorySwap": "512m",
  "cpus": 1,
  "ulimits": { "nofile": "1024:1024" },
  "readOnlyRoot": true,
  "tmpfs": ["/tmp", "/var/tmp", "/run"],
  "network": "none",
  "capDrop": ["ALL"],
  "binds": []
}
```

- [ ] **Step 4: Implement three-stage attestation**

1. `docker version` and `docker image inspect` resolve the configured image to immutable `sha256:<id>`.
2. Start a dedicated loopback OpenClaw Gateway on an ephemeral port with generated gateway token, isolated state/config/workspace and only the Agent Guard plugin enabled.
3. Before and after the run, execute `openclaw sandbox explain --session <key> --json`; after execution also inspect the labeled container and compare network, mounts, readonly root, caps and resource limits.

Any mismatch throws `SandboxPreflightError` or `SandboxAttestationError`. Cleanup removes only containers and networks carrying the exact `agent-guard.run-group=<runGroupId>` label and deletes the verified temp root.

- [ ] **Step 5: Add optional controlled network sink**

For explicitly marked network cases, create an internal Docker network and a sink container from the already resolved sandbox image running `python3 -u -m http.server 8080`. The agent container joins only this internal network. Record sink logs, and remove both sink and network in `finally`. All unmarked cases remain `network=none`.

- [ ] **Step 6: Pass runtime environment to OpenClaw CLI**

Extend `OpenClawRunOptions` with `env`, `gatewayUrl`, `gatewayToken` and `nativeGuardRequired`. `spawnOpenClawAgent` must use the isolated environment and abort signal. It must not mutate global OpenClaw configuration.

- [ ] **Step 7: Run unit tests**

Run: `node --import tsx --test backend/src/modules/openclaw/detectionOpenClawConfig.test.ts backend/src/modules/openclaw/detectionSandboxManager.test.ts && npm run typecheck`

Expected: PASS without requiring Docker because command execution is injected.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/openclaw/detection* backend/src/modules/agent/openclawAdapter.ts backend/src/modules/agent/openclawSession.ts
git commit -m "feat: isolate OpenClaw detection in Docker"
```

---

### Task 12: Detection Orchestration And Real Hook Evidence

**Files:**
- Create: `backend/src/modules/openclaw/nativeGuardTraceProjector.ts`
- Create: `backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts`
- Modify: `backend/src/modules/agent/agentAdapter.ts`
- Modify: `backend/src/modules/agent/openclawAdapter.ts`
- Modify: `backend/src/modules/agent/openclawSession.ts`
- Modify: `backend/src/modules/runner/testRunner.ts`
- Modify: `backend/src/services/e2eRunService.ts`
- Modify: `backend/src/api/types.ts`

- [ ] **Step 1: Write failing reconciliation tests**

```typescript
test("JSONL call without guarded before event is a coverage breach", () => {
  const now = "2026-08-01T00:00:00.000Z";
  assert.throws(
    () => reconcileNativeGuardEvidence({
      toolCalls: [{ callId: "call.1", toolName: "exec", arguments: {}, timestamp: now }],
      toolResults: [],
      guardEvents: [],
      guardRequired: true,
    }),
    /NATIVE_GUARD_COVERAGE_BREACH/,
  );
});
```

Add cases for allow+outcome, deny without outcome, cancelled call, duplicate outcome, incomplete allow, and OFF mode where guard evidence is not required.

- [ ] **Step 2: Run test and verify failure**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Add the session runtime-evidence interface**

```typescript
export type AgentSessionRuntimeEvidence = {
  nativeGuardEvents: NativeGuardEvent[];
  supervisionRecords: RuntimeSupervisionRecord[];
};

export type AgentSession = {
  // existing members
  drainRuntimeEvidence?(): Promise<AgentSessionRuntimeEvidence>;
};
```

`OpenClawSession` collects events from `NativeGuardEventStore` by run ID after CLI completion, reconciles them with parsed JSONL and returns them once through `drainRuntimeEvidence()`.

- [ ] **Step 4: Remove replay from formal Trace**

Delete the call to `replayToolCallsToTrace` and remove that helper. Keep JSONL parsing and artifact copying. Project real decision and outcome events into `tool_call`, `tool_result` and `system_error` events with the original `toolCallId` as call ID.

- [ ] **Step 5: Wire run-group lifecycle**

For OpenClaw detection in `e2eRunService.ts`:

```text
start isolated runtime
for each case: preflight session -> activate detection baseline lease -> run -> revoke in finally
after each case: attest and save evidence
after run/cancel/error: stop gateway -> revoke remaining leases -> clean labeled Docker objects
```

Add `nativeGuardCoverage` and `sandboxEvidence` summaries to `P2RunGroup`. Docker failure must set run phase `failed`, include a stable failure category and execute zero attack cases.

- [ ] **Step 6: Run focused and pipeline tests**

Run: `node --import tsx --test backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts && npm run verify:full-pipeline && npm run typecheck`

Expected: PASS; mock/http adapters remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/agent backend/src/modules/openclaw/nativeGuardTraceProjector* backend/src/modules/runner/testRunner.ts backend/src/services/e2eRunService.ts backend/src/api/types.ts
git commit -m "feat: build traces from native guard hook evidence"
```

---

### Task 13: Realtime Publication And Frontend Coverage Controls

**Files:**
- Modify: `backend/src/modules/openclaw/realtimeMcpServer.ts`
- Modify: `backend/src/api/v1/system/handlers.ts`
- Modify: `frontend/src/lib/api/types.ts`
- Create: `frontend/src/lib/api/nativeGuard.ts`
- Modify: `frontend/src/lib/api/core.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/System/SystemPage.tsx`
- Modify: `frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx`
- Modify: `frontend/src/pages/Supervision/LiveSupervisionPage.tsx`
- Modify: `frontend/src/styles/app.css`
- Create: `frontend/src/lib/models/nativeGuard.test.ts`

- [ ] **Step 1: Write failing frontend model tests**

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { nativeGuardCoverageLabel } from "./nativeGuard";

test("only active is displayed as complete native supervision", () => {
  assert.equal(nativeGuardCoverageLabel("active"), "原生工具完整监督");
  assert.notEqual(nativeGuardCoverageLabel("conditional"), "原生工具完整监督");
  assert.notEqual(nativeGuardCoverageLabel("unsupported"), "原生工具完整监督");
});
```

Add tests for sandbox evidence labels and native event mapping.

- [ ] **Step 2: Run frontend tests and verify failure**

Run: `node --import tsx --test frontend/src/lib/models/nativeGuard.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Publish native events through the existing realtime stream**

Export a bounded `publishRealtimeEvent` adapter from `realtimeMcpServer.ts`. Subscribe it to `NativeGuardEventStore` once at startup. Map native events to existing realtime events with `detail.source="native_tool_hook"`, preserving lease, tool call, decision and coverage identifiers.

- [ ] **Step 4: Add the frontend API**

```typescript
export const nativeGuardApi = {
  status: () => request<NativeGuardStatus>("/api/v1/openclaw/native-guard/status"),
  activate: (input: { rootSessionKey: string; policyPackId: string; mode: "supervision" }) =>
    controlRequest<NativeGuardStatus>("/api/v1/openclaw/native-guard/leases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  renew: (leaseId: string) => controlRequest<NativeGuardStatus>(
    `/api/v1/openclaw/native-guard/leases/${encodeURIComponent(leaseId)}/renew`,
    { method: "POST" },
  ),
  revoke: (leaseId: string) => controlRequest<NativeGuardStatus>(
    `/api/v1/openclaw/native-guard/leases/${encodeURIComponent(leaseId)}`,
    { method: "DELETE" },
  ),
};
```

`controlRequest` adds the Vite token only in browser development; Electron adds it at the network layer.

- [ ] **Step 5: Add status and workflow UI**

- System page: show plugin version, OpenClaw version, coverage, active lease count and reason code.
- Detection workflow: show Docker preflight/attestation state, immutable image ID, network mode and cleanup result.
- Live supervision: add a compact session-key input plus Activate, Renew and Revoke controls. Keep the current MCP ask panel for MCP approvals.
- Native `ask` events must state that approval is handled by OpenClaw. Do not create a second Agent Guard approval button for native tools.
- Only `active` uses the “完整监督” label; `conditional`, `unsupported` and `misconfigured` use explicit warning text.

- [ ] **Step 6: Run frontend verification**

Run: `node --import tsx --test frontend/src/lib/models/nativeGuard.test.ts && npm run test:frontend && npm run typecheck:frontend && npm run build:frontend`

Expected: PASS and production build exits 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/openclaw/realtimeMcpServer.ts backend/src/api/v1/system/handlers.ts frontend/src
git commit -m "feat: expose native guard coverage and controls"
```

---

### Task 14: Installation, Live Verification, Documentation And Final Gate

**Files:**
- Create: `scripts/install-openclaw-native-guard.ps1`
- Create: `scripts/verify-openclaw-native-guard.ts`
- Create: `scripts/verify-openclaw-detection-sandbox.ts`
- Modify: `package.json`
- Modify: `docs/C/openclaw-local-install-and-demo-runbook.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add installer capability checks**

The PowerShell installer must:

```text
1. run npm run build:openclaw-plugin
2. read openclaw --version
3. refuse versions below 2026.7.2 without modifying OpenClaw
4. install the local plugin directory only on compatible hosts
5. run openclaw plugins doctor/status and query the authenticated plugin status route
6. leave the plugin installed but OFF, with zero leases
```

Never modify the user tool allow/deny policy or enable Docker globally.

- [ ] **Step 2: Add fake-host and backend verification**

`verify-openclaw-native-guard.ts` must assert:

- manifest declares trusted policy contract;
- OFF returns without fetch or audit;
- active allow, deny, redact and ask mappings;
- invalid signature and timeout fail closed for high-risk tools;
- subagent inheritance and restart recovery;
- backend auth, replay defense and event idempotency;
- current incompatible OpenClaw reports `unsupported`, not `active`.
- a second enabled `before_tool_call` plugin reports `conditional` and prevents activation;
- 10,000 OFF Hook calls make zero network/filesystem calls and have p95 below 1 ms;
- 500 local signed allow decisions have p95 below 100 ms, excluding approval waits.

- [ ] **Step 3: Add Docker live verification**

`verify-openclaw-detection-sandbox.ts` must skip with exit code 0 only when `AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1`; otherwise missing Docker or compatible OpenClaw is a failure. On a compatible environment it must prove:

```text
container PID differs from host
host canary is unreadable/unwritable
root is readonly
capabilities are dropped
memory/CPU/PID limits match
default network has no egress
controlled sink has no Internet route
Docker socket is absent
cancel leaves no labeled container/network
```

- [ ] **Step 4: Add package commands**

```json
"verify:native-guard": "node --import tsx scripts/verify-openclaw-native-guard.ts",
"verify:native-guard:docker": "node --import tsx scripts/verify-openclaw-detection-sandbox.ts",
"verify:native-guard:all": "npm run test:native-guard:protocol && npm run test:native-guard:plugin && npm run verify:native-guard && npm run verify:native-guard:docker"
```

Add non-Docker native guard verification to `verify:all`. Keep the live Docker command separate so ordinary unit CI does not silently claim Docker coverage.

- [ ] **Step 5: Update runbooks and architecture**

Document:

- supported OpenClaw version and the current `2026.6.1` upgrade requirement;
- plugin build/install/enable/status commands;
- gateway token and Agent Guard control-token handling;
- session lease activation, renewal, explicit revoke and recovery;
- detection Docker prerequisites and immutable image resolution;
- OFF behavior and rollback procedure;
- the non-coverage boundary for native plugin-internal side effects;
- interpretation of `off`, `active`, `recovery`, `conditional`, `unsupported` and `misconfigured`.

- [ ] **Step 6: Run the complete non-live regression suite**

Run:

```bash
npm run typecheck
npm run typecheck:frontend
npm run typecheck:openclaw-plugin
npm run test:native-guard:protocol
npm run test:native-guard:plugin
npm run verify:native-guard
npm run verify:openclaw:realtime
npm run verify:full-pipeline
npm run test:frontend
npm run build:frontend
npm run build:openclaw-plugin
```

Expected: all commands exit 0. On the current machine, the capability test must explicitly report OpenClaw `2026.6.1` as `unsupported` while OFF regression passes.

- [ ] **Step 7: Run Docker/live verification on a compatible OpenClaw host**

Run: `npm run verify:native-guard:docker`

Expected: PASS with container, network, mount, resource and cleanup evidence. If OpenClaw 2026.7.2 is not available, report the live-test blocker verbatim; do not mark the feature fully verified.

- [ ] **Step 8: Inspect the final diff and secret scan**

Run:

```bash
git diff --check
git diff --stat main...HEAD
rg -n "credential|Authorization|PRIVATE KEY|OPENCLAW_GATEWAY_TOKEN" outputs docs backend plugins frontend scripts -g '!*.test.ts'
```

Expected: no whitespace errors; every secret match is a field name, redaction rule or environment-variable reference, never a real value.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/install-openclaw-native-guard.ps1 scripts/verify-openclaw-native-guard.ts scripts/verify-openclaw-detection-sandbox.ts docs/C/openclaw-local-install-and-demo-runbook.md docs/architecture.md
git commit -m "docs: add native guard operations and verification"
```

---

## Completion Criteria

The work is complete only when all of the following are true:

- No lease means no Agent Guard fetch, audit, approval, parameter rewrite or block.
- A valid supervision lease covers the root session and spawned child sessions.
- All standard OpenClaw tool calls enter Trusted Admission; no name-prefix bypass exists.
- High-risk and unknown tools fail closed during ACTIVE PDP failure and unexpired recovery.
- Signed decisions are bound to lease, session, tool call, tool identity and exact parameter digest.
- Native ask uses OpenClaw `requireApproval` with allow-once/deny only.
- Detection cannot start without compatible OpenClaw, the plugin, Docker and successful preflight.
- Detection uses an isolated profile and never edits the user OpenClaw config.
- Formal Trace and supervision records come from real Hook events and reconcile with JSONL.
- UI reports conditional/unsupported states honestly and uses “完整监督” only for active coverage.
- Current OpenClaw 2026.6.1 remains usable in OFF mode and is rejected for guarded mode.
- The deleted `docs/p4-native-tool-bypass-defense-plan.md` remains untouched unless the user separately restores it.
