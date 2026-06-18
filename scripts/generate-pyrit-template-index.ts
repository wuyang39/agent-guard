import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { corpusSourceFiles, resolveCorpusLayout } from "../backend/src/modules/corpus";

type TemplateRef = {
  templateId: string;
  name: string;
  groupId: string;
  sourcePath: string;
  sourceName?: string;
  authors: string[];
  parameters: string[];
  dataType?: string;
  harmCategories: string[];
  isGeneralTechnique?: boolean;
  byteLength: number;
  sha256: string;
};

type TemplateGroup = {
  groupId: string;
  name: string;
  sourcePath: string;
  templateCount: number;
};

const rootDir = process.cwd();
const layout = resolveCorpusLayout(rootDir);
const templateRoot = path.resolve(
  rootDir,
  "third_party",
  "pyrit_adapted",
  "pyrit",
  "datasets",
  "jailbreak",
  "templates",
);
const outputPath = path.join(layout.sourceDir, corpusSourceFiles.pyritJailbreakTemplates);

async function main(): Promise<void> {
  await mkdir(layout.sourceDir, { recursive: true });
  const files = (await listTemplateFiles(templateRoot)).sort((a, b) => a.localeCompare(b));
  const templates: TemplateRef[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const normalizedContent = normalizeLineEndings(content);
    const metadata = parseMetadata(content);
    const relativePath = toPosix(path.relative(rootDir, filePath));
    const relativeTemplatePath = toPosix(path.relative(templateRoot, filePath));
    const groupId = buildGroupId(path.dirname(relativeTemplatePath));

    templates.push({
      templateId: `pyrit.jailbreak.template.${sanitizeId(relativeTemplatePath.replace(/\.(ya?ml)$/i, ""))}`,
      name: metadata.name ?? path.basename(filePath, path.extname(filePath)),
      groupId,
      sourcePath: relativePath,
      ...(metadata.source ? { sourceName: metadata.source } : {}),
      authors: metadata.authors,
      parameters: metadata.parameters,
      ...(metadata.dataType ? { dataType: metadata.dataType } : {}),
      harmCategories: metadata.harmCategories,
      ...(typeof metadata.isGeneralTechnique === "boolean"
        ? { isGeneralTechnique: metadata.isGeneralTechnique }
        : {}),
      byteLength: Buffer.byteLength(normalizedContent, "utf8"),
      sha256: createHash("sha256").update(normalizedContent).digest("hex"),
    });
  }

  const groups = buildGroups(templates);
  const payload = {
    schemaVersion: "mvp-1",
    indexId: "pyrit.jailbreak_templates.p2",
    name: "PyRIT jailbreak template metadata index",
    description:
      "Metadata-only index of vendored PyRIT jailbreak templates. The full template text stays only in third_party/pyrit_adapted and is not copied into this config.",
    sourcePath: toPosix(path.relative(rootDir, templateRoot)),
    generatedAt: "2026-06-15",
    totalTemplates: templates.length,
    groups,
    templates,
    safetyNotes:
      "This index intentionally excludes the YAML value field to avoid exposing full jailbreak prompt text through Agent Guard configs, API views, or reports.",
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${templates.length} PyRIT jailbreak template refs to ${toPosix(path.relative(rootDir, outputPath))}`);
}

async function listTemplateFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTemplateFiles(entryPath)));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function parseMetadata(content: string): {
  name?: string;
  source?: string;
  authors: string[];
  parameters: string[];
  dataType?: string;
  harmCategories: string[];
  isGeneralTechnique?: boolean;
} {
  const header = content.split(/\r?\nvalue\s*:/i)[0] ?? content;
  return {
    name: readScalar(header, "name"),
    source: readScalar(header, "source"),
    authors: readList(header, "authors"),
    parameters: readList(header, "parameters"),
    dataType: readScalar(header, "data_type"),
    harmCategories: readList(header, "harm_categories"),
    isGeneralTechnique: readBoolean(header, "is_general_technique"),
  };
}

function readScalar(content: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.replace(/^["']|["']$/g, "").trim();
}

function readBoolean(content: string, key: string): boolean | undefined {
  const value = readScalar(content, key);
  if (!value) {
    return undefined;
  }
  if (/^true$/i.test(value)) {
    return true;
  }
  if (/^false$/i.test(value)) {
    return false;
  }
  return undefined;
}

function readList(content: string, key: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) {
    const inline = readScalar(content, key);
    return inline ? [inline] : [];
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match?.[1]) {
      values.push(match[1].replace(/^["']|["']$/g, "").trim());
    }
  }
  return values;
}

function buildGroups(templates: TemplateRef[]): TemplateGroup[] {
  const countByGroup = new Map<string, number>();
  const pathByGroup = new Map<string, string>();

  for (const template of templates) {
    countByGroup.set(template.groupId, (countByGroup.get(template.groupId) ?? 0) + 1);
    if (!pathByGroup.has(template.groupId)) {
      pathByGroup.set(template.groupId, groupSourcePath(template.sourcePath));
    }
  }

  return [...countByGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupId, templateCount]) => ({
      groupId,
      name: groupId === "root" ? "root templates" : groupId.replace(/\./g, "/"),
      sourcePath: pathByGroup.get(groupId) ?? "third_party/pyrit_adapted/pyrit/datasets/jailbreak/templates",
      templateCount,
    }));
}

function groupSourcePath(templateSourcePath: string): string {
  const dir = path.posix.dirname(templateSourcePath);
  return dir === "." ? "third_party/pyrit_adapted/pyrit/datasets/jailbreak/templates" : dir;
}

function buildGroupId(relativeDir: string): string {
  if (relativeDir === "." || relativeDir === "") {
    return "root";
  }
  return sanitizeId(relativeDir);
}

function sanitizeId(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\//g, ".")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
