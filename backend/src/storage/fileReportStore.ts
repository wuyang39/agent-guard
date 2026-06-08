/**
 * fileReportStore — 文件级 Report Index
 *
 * 存储位置: outputs/report-index/
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { P2ArtifactView } from "../api/types";
import type { ReportArtifact } from "@agent-guard/contracts";

const ROOT = path.resolve(process.cwd(), "outputs", "report-index");
const INDEX_FILE = path.join(ROOT, "report-index.json");

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

// ---- Report Index ----

export async function indexReport(entry: ReportIndexEntry): Promise<void> {
  const index = await readJson<ReportIndex>(INDEX_FILE, { version: 1, entries: [] });
  const existing = index.entries.findIndex(
    (e) => e.reportId === entry.reportId,
  );
  if (existing >= 0) {
    index.entries[existing] = entry;
  } else {
    index.entries.push(entry);
  }
  await writeJson(INDEX_FILE, index);
}

export async function getReportEntry(
  reportId: string,
): Promise<ReportIndexEntry | undefined> {
  const index = await readJson<ReportIndex>(INDEX_FILE, { version: 1, entries: [] });
  return index.entries.find((e) => e.reportId === reportId);
}

// ---- Artifact Index ----

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
    const raw = await fs.readFile(
      path.join(ROOT, "artifacts", `${artifactId}.json`),
      "utf-8",
    );
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
