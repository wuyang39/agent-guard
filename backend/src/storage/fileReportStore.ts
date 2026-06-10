import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportArtifact } from "@agent-guard/contracts";
import type {
  CLineRunBundle,
  CLineRunGroup,
  CLineDashboardSummary,
} from "../services/cLineRunTypes";

type StoreIndex = {
  schemaVersion: "mvp-1";
  latestRunGroupId?: string;
  runGroups: CLineRunGroup[];
};

const emptyCounts: CLineDashboardSummary["countsByCategory"] = {
  tool_misuse: 0,
  unauthorized_access: 0,
  data_leakage: 0,
  dangerous_action: 0,
  instruction_injection_following: 0,
};

const riskRank = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

export type FileReportStore = {
  baseDir: string;
  saveBundle(bundle: CLineRunBundle): Promise<CLineRunBundle>;
  listRunGroups(): Promise<CLineRunGroup[]>;
  getLatestBundle(): Promise<CLineRunBundle | undefined>;
  getBundle(runGroupId: string): Promise<CLineRunBundle | undefined>;
  findBundleByTraceId(traceId: string): Promise<CLineRunBundle | undefined>;
  findBundleByRiskReportId(reportId: string): Promise<CLineRunBundle | undefined>;
  findBundleByDetectionReportId(reportId: string): Promise<CLineRunBundle | undefined>;
  findBundleByPolicyPackId(policyPackId: string): Promise<CLineRunBundle | undefined>;
  findBundleByDefenseReportId(reportId: string): Promise<CLineRunBundle | undefined>;
  findBundleByRuntimeSessionId(runtimeSessionId: string): Promise<CLineRunBundle | undefined>;
  findArtifact(artifactId: string): Promise<ReportArtifact | undefined>;
  buildDashboardSummary(): Promise<CLineDashboardSummary>;
};

export function createFileReportStore(baseDir: string): FileReportStore {
  const normalizedBaseDir = path.resolve(baseDir);

  return {
    baseDir: normalizedBaseDir,

    async saveBundle(bundle) {
      await ensureStoreDirs(normalizedBaseDir);
      const bundlePath = getBundlePath(normalizedBaseDir, bundle.runGroup.runGroupId);
      await mkdir(path.dirname(bundlePath), { recursive: true });
      await writeJson(bundlePath, bundle);

      const index = await readIndex(normalizedBaseDir);
      const withoutCurrent = index.runGroups.filter(
        (runGroup) => runGroup.runGroupId !== bundle.runGroup.runGroupId,
      );
      await writeIndex(normalizedBaseDir, {
        schemaVersion: "mvp-1",
        latestRunGroupId: bundle.runGroup.runGroupId,
        runGroups: [bundle.runGroup, ...withoutCurrent].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        ),
      });

      return bundle;
    },

    async listRunGroups() {
      const index = await readIndex(normalizedBaseDir);
      return [...index.runGroups].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    },

    async getLatestBundle() {
      const index = await readIndex(normalizedBaseDir);
      if (!index.latestRunGroupId) {
        return undefined;
      }
      return readBundle(normalizedBaseDir, index.latestRunGroupId);
    },

    async getBundle(runGroupId) {
      return readBundle(normalizedBaseDir, runGroupId);
    },

    async findBundleByTraceId(traceId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.traces.some((trace) => trace.traceId === traceId),
      );
    },

    async findBundleByRiskReportId(reportId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.riskReports.some((report) => report.reportId === reportId),
      );
    },

    async findBundleByDetectionReportId(reportId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.detectionReport.reportId === reportId,
      );
    },

    async findBundleByPolicyPackId(policyPackId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.policyPack.policyPackId === policyPackId,
      );
    },

    async findBundleByDefenseReportId(reportId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.defenseReport.defenseReportId === reportId,
      );
    },

    async findBundleByRuntimeSessionId(runtimeSessionId) {
      return findBundle(normalizedBaseDir, (bundle) =>
        bundle.supervisionRecords.some(
          (record) => record.runtimeSessionId === runtimeSessionId,
        ),
      );
    },

    async findArtifact(artifactId) {
      const bundle = await findBundle(normalizedBaseDir, (candidate) =>
        candidate.artifacts.some((artifact) => artifact.artifactId === artifactId),
      );
      return bundle?.artifacts.find((artifact) => artifact.artifactId === artifactId);
    },

    async buildDashboardSummary() {
      const runGroups = await this.listRunGroups();
      const bundles = (
        await Promise.all(runGroups.map((runGroup) => readBundle(normalizedBaseDir, runGroup.runGroupId)))
      ).filter((bundle): bundle is CLineRunBundle => bundle !== undefined);

      const countsByCategory = { ...emptyCounts };
      let highestRiskLevel: CLineDashboardSummary["highestRiskLevel"] = "low";
      let traces = 0;
      let riskReports = 0;
      let findings = 0;
      let blockedActions = 0;
      let redactions = 0;
      let askDecisions = 0;
      let residualRisks = 0;

      for (const bundle of bundles) {
        traces += bundle.traces.length;
        riskReports += bundle.riskReports.length;
        blockedActions += bundle.defenseReport.blockedActions.length;
        redactions += bundle.defenseReport.defenseEffectiveness.redactedActionCount;
        askDecisions += bundle.defenseReport.defenseEffectiveness.askDecisionCount;
        residualRisks += bundle.defenseReport.residualRisk.length;

        for (const report of bundle.riskReports) {
          findings += report.summary.totalFindings;
          if (riskRank[report.riskLevel] > riskRank[highestRiskLevel]) {
            highestRiskLevel = report.riskLevel;
          }
          for (const [category, count] of Object.entries(report.summary.countsByCategory)) {
            countsByCategory[category as keyof typeof countsByCategory] += count;
          }
        }
      }

      return {
        schemaVersion: "mvp-1",
        latestRunGroup: runGroups[0],
        recentRunGroups: runGroups.slice(0, 5),
        totals: {
          runGroups: runGroups.length,
          traces,
          riskReports,
          findings,
          blockedActions,
          redactions,
          askDecisions,
          residualRisks,
        },
        highestRiskLevel,
        countsByCategory,
      };
    },
  };
}

async function ensureStoreDirs(baseDir: string): Promise<void> {
  await mkdir(path.join(baseDir, "run-groups"), { recursive: true });
  await mkdir(path.join(baseDir, "artifacts"), { recursive: true });
}

function getIndexPath(baseDir: string): string {
  return path.join(baseDir, "index.json");
}

function getBundlePath(baseDir: string, runGroupId: string): string {
  return path.join(baseDir, "run-groups", `${safeId(runGroupId)}.json`);
}

async function readIndex(baseDir: string): Promise<StoreIndex> {
  try {
    return JSON.parse(await readFile(getIndexPath(baseDir), "utf8")) as StoreIndex;
  } catch {
    return {
      schemaVersion: "mvp-1",
      runGroups: [],
    };
  }
}

async function writeIndex(baseDir: string, index: StoreIndex): Promise<void> {
  await ensureStoreDirs(baseDir);
  await writeJson(getIndexPath(baseDir), index);
}

async function readBundle(
  baseDir: string,
  runGroupId: string,
): Promise<CLineRunBundle | undefined> {
  try {
    return JSON.parse(await readFile(getBundlePath(baseDir, runGroupId), "utf8")) as CLineRunBundle;
  } catch {
    return undefined;
  }
}

async function findBundle(
  baseDir: string,
  predicate: (bundle: CLineRunBundle) => boolean,
): Promise<CLineRunBundle | undefined> {
  const index = await readIndex(baseDir);
  for (const runGroup of index.runGroups) {
    const bundle = await readBundle(baseDir, runGroup.runGroupId);
    if (bundle && predicate(bundle)) {
      return bundle;
    }
  }
  return undefined;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
