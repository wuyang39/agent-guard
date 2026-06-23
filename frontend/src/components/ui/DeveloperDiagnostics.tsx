import type { ReactNode } from "react";

export type DiagnosticItem = {
  label: string;
  value?: ReactNode;
};

export type DiagnosticColumn<Row> = {
  header: string;
  render: (row: Row) => ReactNode;
  className?: string;
};

type DeveloperDiagnosticsProps = {
  title?: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function DeveloperDiagnostics({
  title = "开发者诊断",
  count,
  defaultOpen = false,
  children,
}: DeveloperDiagnosticsProps) {
  return (
    <details className="developer-details developer-diagnostics" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {count !== undefined ? <strong>{count}</strong> : null}
      </summary>
      <div className="developer-diagnostics-body">{children}</div>
    </details>
  );
}

export function DiagnosticKeyValueGrid({ items }: { items: DiagnosticItem[] }) {
  const visibleItems = items.filter((item) => item.value !== undefined && item.value !== null);
  if (!visibleItems.length) return null;

  return (
    <div className="developer-detail-grid diagnostic-key-value-grid">
      {visibleItems.map((item) => (
        <div className="developer-detail-item" key={item.label}>
          <span>{item.label}</span>
          <code>{formatDiagnosticValue(item.value)}</code>
        </div>
      ))}
    </div>
  );
}

export function DiagnosticSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="diagnostic-section">
      <div className="diagnostic-section-header">
        <h3>{title}</h3>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function DiagnosticTable<Row>({
  rows,
  columns,
  rowKey,
  emptyLabel = "暂无数据",
  maxRows,
}: {
  rows: Row[];
  columns: DiagnosticColumn<Row>[];
  rowKey: (row: Row, index: number) => string;
  emptyLabel?: string;
  maxRows?: number;
}) {
  const visibleRows = maxRows ? rows.slice(0, maxRows) : rows;

  if (!rows.length) {
    return <p className="muted diagnostic-empty">{emptyLabel}</p>;
  }

  return (
    <>
      <div className="table-wrap diagnostic-table-wrap">
        <table className="diagnostic-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th className={column.className} key={column.header}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={rowKey(row, index)}>
                {columns.map((column) => (
                  <td className={column.className} key={column.header}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibleRows.length < rows.length ? (
        <p className="field-note">已显示 {visibleRows.length}/{rows.length} 行。</p>
      ) : null}
    </>
  );
}

export function DiagnosticJson({
  value,
  emptyLabel = "暂无 JSON 明细",
}: {
  value?: unknown;
  emptyLabel?: string;
}) {
  if (value === undefined || value === null) {
    return <p className="muted diagnostic-empty">{emptyLabel}</p>;
  }

  return <pre className="diagnostic-json">{JSON.stringify(value, null, 2)}</pre>;
}

function formatDiagnosticValue(value: ReactNode): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "") return "-";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return String(value ?? "-");
}
