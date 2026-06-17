import type { RiskLevel } from "../../lib/api/demoRuntime";
import { riskLabel } from "../../lib/formatters/display";

type RiskBadgeProps = {
  level?: RiskLevel;
};

export function RiskBadge({ level = "none" }: RiskBadgeProps) {
  return <span className={`risk-badge risk-${level}`}>{riskLabel[level]}</span>;
}
