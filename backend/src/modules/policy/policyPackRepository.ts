import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { getReportEntry } from "../../storage/fileReportStore";
import { getRunGroup } from "../../storage/fileRunStore";
import { resolveInsideDirectory } from "../../storage/pathSafety";

const REPORTS_DIR = path.resolve(process.cwd(), "outputs", "reports");

export async function loadStoredOpenClawPolicyPack(
  policyPackId: string,
): Promise<{
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
} | undefined> {
  const entry = await getReportEntry(policyPackId);
  if (!entry || entry.reportType !== "policy_pack") return undefined;

  const runGroup = await getRunGroup(entry.runGroupId);
  if (!runGroup || runGroup.adapterKind !== "openclaw") return undefined;
  if (
    runGroup.policyContextSource &&
    runGroup.policyContextSource !== "stored_detection"
  ) {
    return undefined;
  }

  const filePath = path.join(
    resolveInsideDirectory(REPORTS_DIR, entry.runGroupId),
    "supervision-policy-pack.json",
  );
  const policyPack = JSON.parse(
    await fs.readFile(filePath, "utf8"),
  ) as SupervisionPolicyPack;
  if (
    policyPack.policyPackId !== policyPackId ||
    policyPack.policies.length === 0
  ) {
    return undefined;
  }

  return {
    policyPack,
    policyPackDigest: digestJson(policyPack),
    runGroupId: entry.runGroupId,
  };
}
