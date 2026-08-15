/** Shared chart scaffolding: sizing, axes, and the single shared tooltip. */
import * as d3 from "d3";

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_MARGIN: Margin = {
  top: 12,
  right: 16,
  bottom: 42,
  left: 56,
};

export interface Frame {
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  plot: d3.Selection<SVGGElement, unknown, null, undefined>;
  width: number;
  height: number;
  margin: Margin;
}

/**
 * Create a responsive SVG inside `container`, sized to the container's width
 * and the requested height, returning a plot group inset by the margin.
 */
export function frame(
  container: HTMLElement,
  height: number,
  margin: Margin = DEFAULT_MARGIN,
): Frame {
  container.replaceChildren();
  const outerWidth = Math.max(320, container.clientWidth || 640);
  const width = outerWidth - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("class", "chart")
    .attr("viewBox", `0 0 ${outerWidth} ${height}`)
    .attr("width", outerWidth)
    .attr("height", height);

  const plot = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  return { svg, plot, width, height: innerHeight, margin };
}

/** Horizontal gridlines plus a left axis. */
export function yAxis(
  f: Frame,
  scale: d3.ScaleContinuousNumeric<number, number>,
  title: string,
  ticks?: number[],
  format: (v: number) => string = (v) => String(v),
): void {
  const values = ticks ?? scale.ticks(6);
  const g = f.plot.append("g").attr("class", "y-axis");
  for (const v of values) {
    const y = scale(v);
    if (!Number.isFinite(y)) continue;
    g.append("line")
      .attr("class", "grid-line")
      .attr("x1", 0)
      .attr("x2", f.width)
      .attr("y1", y)
      .attr("y2", y);
    g.append("text")
      .attr("class", "tick-label")
      .attr("x", -8)
      .attr("y", y)
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text(format(v));
  }
  f.svg
    .append("text")
    .attr("class", "axis-title")
    .attr("transform", "rotate(-90)")
    .attr("x", -(f.margin.top + f.height / 2))
    .attr("y", 14)
    .attr("text-anchor", "middle")
    .text(title);
}

/** Bottom axis with a baseline. */
export function xAxis(
  f: Frame,
  scale: d3.ScaleContinuousNumeric<number, number>,
  title: string,
  ticks?: number[],
  format: (v: number) => string = (v) => String(v),
): void {
  const values = ticks ?? scale.ticks(6);
  const g = f.plot.append("g").attr("class", "x-axis");
  g.append("line")
    .attr("class", "axis-line")
    .attr("x1", 0)
    .attr("x2", f.width)
    .attr("y1", f.height)
    .attr("y2", f.height);
  for (const v of values) {
    const x = scale(v);
    if (!Number.isFinite(x)) continue;
    g.append("text")
      .attr("class", "tick-label")
      .attr("x", x)
      .attr("y", f.height + 16)
      .attr("text-anchor", "middle")
      .text(format(v));
  }
  f.svg
    .append("text")
    .attr("class", "axis-title")
    .attr("x", f.margin.left + f.width / 2)
    .attr("y", f.height + f.margin.top + 36)
    .attr("text-anchor", "middle")
    .text(title);
}

// ---------------------------------------------------------------- tooltip

let tooltipEl: HTMLElement | null = null;

function tooltip(): HTMLElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "tooltip";
    tooltipEl.setAttribute("role", "status");
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

export interface TooltipContent {
  title: string;
  rows: [string, string][];
  footer?: string;
}

export function showTooltip(event: MouseEvent, content: TooltipContent): void {
  const el = tooltip();
  const rows = content.rows
    .map(
      ([k, v]) =>
        `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`,
    )
    .join("");
  el.innerHTML =
    `<div class="t-title">${escapeHtml(content.title)}</div><dl>${rows}</dl>` +
    (content.footer ? `<div class="t-foot">${escapeHtml(content.footer)}</div>` : "");
  el.dataset.show = "true";
  moveTooltip(event);
}

export function moveTooltip(event: MouseEvent): void {
  const el = tooltip();
  const pad = 14;
  const rect = el.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

export function hideTooltip(): void {
  tooltip().dataset.show = "false";
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

// ------------------------------------------------------------- formatting

export function fmt(x: number | null | undefined, digits = 2): string {
  return x == null || !Number.isFinite(x) ? "—" : x.toFixed(digits);
}

export function fmtP(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

export function fmtInt(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "—" : Math.round(x).toLocaleString();
}

/** Hazard ratio with its confidence interval, e.g. "0.75 (0.51–1.11)". */
export function fmtCi(
  rr: number | null,
  lb: number | null,
  ub: number | null,
): string {
  if (rr == null || !Number.isFinite(rr)) return "—";
  if (lb == null || ub == null) return fmt(rr);
  return `${fmt(rr)} (${fmt(lb)}–${fmt(ub)})`;
}

/** Redraw `render` when the container's width changes. */
export function onResize(container: HTMLElement, render: () => void): void {
  let width = container.clientWidth;
  const observer = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - width) > 12) {
      width = container.clientWidth;
      render();
    }
  });
  observer.observe(container);
}

/** Legend markup; identity is never carried by color alone. */
export function legend(
  container: HTMLElement,
  items: { label: string; color: string; hollow?: boolean }[],
): void {
  const el = document.createElement("div");
  el.className = "legend";
  el.innerHTML = items
    .map(
      (i) =>
        `<span class="item"><span class="swatch${i.hollow ? " hollow" : ""}" style="${
          i.hollow ? `color:${i.color}` : `background:${i.color}`
        }"></span>${escapeHtml(i.label)}</span>`,
    )
    .join("");
  container.appendChild(el);
}

/** Current value of a CSS custom property on :root. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}
