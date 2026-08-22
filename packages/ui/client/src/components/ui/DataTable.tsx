import type { ReactNode } from "react";

export interface DataTableColumn {
  key: string;
  label: string;
  /** Render cell values as code tags (paths, var names). */
  mono?: boolean;
  width?: string;
}

/** Structured data table with uppercase headers and hairline row dividers. */
export function DataTable(props: {
  columns: DataTableColumn[];
  rows: Record<string, ReactNode>[];
  className?: string;
}) {
  if (props.rows.length === 0) return null;
  return (
    <table className={`ui-data-table${props.className ? ` ${props.className}` : ""}`}>
      <thead>
        <tr>
          {props.columns.map((col) => (
            <th key={col.key} style={col.width ? { width: col.width } : undefined}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, i) => (
          <tr key={i}>
            {props.columns.map((col) => {
              const value = row[col.key];
              return (
                <td key={col.key}>
                  {col.mono && typeof value === "string" ? <code className="ui-code-tag">{value}</code> : value}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
