export type DeveloperDetailItem = {
  label: string;
  value?: string | number | boolean | null;
};

type DeveloperDetailsProps = {
  title?: string;
  items: DeveloperDetailItem[];
  defaultOpen?: boolean;
};

export function DeveloperDetails({
  title = "开发者信息",
  items,
  defaultOpen = false,
}: DeveloperDetailsProps) {
  const visibleItems = items.filter((item) => item.value !== undefined && item.value !== null);
  if (!visibleItems.length) return null;

  return (
    <details className="developer-details" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        <strong>{visibleItems.length}</strong>
      </summary>
      <div className="developer-detail-grid">
        {visibleItems.map((item) => (
          <div className="developer-detail-item" key={item.label}>
            <span>{item.label}</span>
            <code>{formatDetailValue(item.value)}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

function formatDetailValue(value: DeveloperDetailItem["value"]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "") return "-";
  return String(value);
}
