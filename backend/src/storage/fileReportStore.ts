/**
 * fileReportStore — 文件级 Report / Artifact Index.
 *
 * 正式 P2 API 使用 outputs/report-index 维护报告和 artifact 的轻量索引。
 * 运行组、监督会话和 trace 分别由 fileRunStore / outputs/traces 管理。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { P2ArtifactView } from "../api/types";
import type { ReportArtifact } from "@agent-guard/contracts";
import { Mutex } from "../shared";
import { resolveInsideDirectory } from "./pathSafety";

const ROOT = path.resolve(process.cwd(), "outputs", "report-index");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const INDEX_FILE = path.join(ROOT, "report-index.json");

/** 保护 report-index.json 的并发 read-modify-write */
const reportIndexMutex = new Mutex();

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

type ReportIndexEntry = {
  reportId: string;
  reportType:
    | "risk_report"
    | "detection_report"
    | "risk_profile"
    | "policy_pack"
    | "defense_report";
  runGroupId: string;
  artifactIds: string[];
  generatedAt: string;
};

type ReportIndex = {
  version: 1;
  entries: ReportIndexEntry[];
};

type ArtifactIndexEntry = {
  artifactId: string;
  reportId: string;
  format: "json" | "html";
  filePath: string;
  label: string;
  generatedAt: string;
};

// ---- B-line Report Index ----

export async function indexReport(entry: ReportIndexEntry): Promise<void> {
  await reportIndexMutex.run(async () => {
    const index = await readJson<ReportIndex>(INDEX_FILE, {
      version: 1,
      entries: [],
    });
    const existing = index.entries.findIndex(
      (item) => item.reportId === entry.reportId,
    );
    if (existing >= 0) {
      index.entries[existing] = entry;
    } else {
      index.entries.push(entry);
    }
    await writeJson(INDEX_FILE, index);
  });
}

export async function getReportEntry(
  reportId: string,
): Promise<ReportIndexEntry | undefined> {
  const index = await readJson<ReportIndex>(INDEX_FILE, {
    version: 1,
    entries: [],
  });
  return index.entries.find((entry) => entry.reportId === reportId);
}

export async function indexArtifact(
  artifact: ReportArtifact,
  label: string,
): Promise<void> {
  const entry: ArtifactIndexEntry = {
    artifactId: artifact.artifactId,
    reportId: artifact.reportId,
    format: artifact.format as "json" | "html",
    filePath: artifact.path,
    label,
    generatedAt: artifact.generatedAt,
  };
  const file = path.join(ROOT, "artifacts", `${entry.artifactId}.json`);
  await writeJson(file, entry);
}

export async function getArtifactEntry(
  artifactId: string,
): Promise<ArtifactIndexEntry | undefined> {
  try {
    const artifactPath = resolveInsideDirectory(ARTIFACTS_DIR, `${artifactId}.json`);
    const raw = await fs.readFile(artifactPath, "utf-8");
    return JSON.parse(raw) as ArtifactIndexEntry;
  } catch {
    return undefined;
  }
}

export function artifactToView(
  entry: ArtifactIndexEntry,
  apiBase: string,
): P2ArtifactView {
  return {
    artifactId: entry.artifactId,
    reportId: entry.reportId,
    format: entry.format,
    label: entry.label,
    url: `${apiBase}/api/v1/artifacts/${entry.artifactId}`,
    generatedAt: entry.generatedAt,
  };
}
