/** A small sortable table. Columns declare how to read, format, and sort. */
import { escapeHtml } from "../charts/common";

export interface Column<T> {
  key: string;
  label: string;
  /** Value used for sorting; also the default cell text when `render` is absent. */
  value: (row: T) => string | number | null;
  render?: (row: T) => string;
  numeric?: boolean;
  title?: string;
}

export interface TableOptions<T> {
  sortKey?: string;
  sortDescending?: boolean;
  onSelect?: (row: T) => void;
  maxHeight?: number;
}

export function renderTable<T>(
  container: HTMLElement,
  rows: T[],
  columns: Column<T>[],
  options: TableOptions<T> = {},
): void {
  let sortKey = options.sortKey ?? columns[0].key;
  let descending = options.sortDescending ?? false;

  const wrap = document.createElement("div");
  wrap.className = options.maxHeight ? "scroll-x scroll-y" : "scroll-x";
  if (options.maxHeight) wrap.style.maxHeight = `${options.maxHeight}px`;
  container.replaceChildren(wrap);

  const draw = () => {
    const column = columns.find((c) => c.key === sortKey) ?? columns[0];
    const sorted = [...rows].sort((a, b) => {
      const av = column.value(a);
      const bv = column.value(b);
      const cmp = compare(av, bv);
      return descending ? -cmp : cmp;
    });

    const head = columns
      .map(
        (c) =>
          `<th class="${c.numeric ? "num" : ""}" data-key="${c.key}"${
            c.title ? ` title="${escapeHtml(c.title)}"` : ""
          } aria-sort="${
            c.key === sortKey ? (descending ? "descending" : "ascending") : "none"
          }">${escapeHtml(c.label)}${
            c.key === sortKey ? (descending ? " ↓" : " ↑") : ""
          }</th>`,
      )
      .join("");

    const body = sorted
      .map((row, i) => {
        const cells = columns
          .map(
            (c) =>
              `<td class="${c.numeric ? "num" : ""}">${
                c.render ? c.render(row) : escapeHtml(text(c.value(row)))
              }</td>`,
          )
          .join("");
        return `<tr data-index="${i}"${
          options.onSelect ? ' class="clickable"' : ""
        }>${cells}</tr>`;
      })
      .join("");

    wrap.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    wrap.querySelectorAll("th").forEach((th) => {
      th.addEventListener("click", () => {
        const key = (th as HTMLElement).dataset.key as string;
        if (key === sortKey) descending = !descending;
        else {
          sortKey = key;
          descending = !!columns.find((c) => c.key === key)?.numeric;
        }
        draw();
      });
    });

    if (options.onSelect) {
      wrap.querySelectorAll("tbody tr").forEach((tr) => {
        tr.addEventListener("click", () => {
          const index = Number((tr as HTMLElement).dataset.index);
          options.onSelect?.(sorted[index]);
        });
      });
    }
  };

  draw();
}

function text(v: string | number | null): string {
  if (v == null) return "—";
  return typeof v === "number" ? (Number.isFinite(v) ? String(v) : "—") : v;
}

function compare(a: string | number | null, b: string | number | null): number {
  // Nulls always sort last, in either direction.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
