/**
 * Drilldown drawer: everything known about a single target/comparator/outcome
 * estimate — the effect across databases, its diagnostics, survival curve,
 * follow-up time, and cohort attrition.
 */
import {
  loadOutcomeAcrossDatabases,
  loadKaplanMeier,
  loadAttrition,
  loadFollowUp,
  shortName,
  type EstimateRow,
  type Selection,
  type Lookups,
} from "../data/model";
import { renderForest } from "../charts/forest";
import { renderKaplanMeier } from "../charts/diagnostics";
import { renderTable } from "./table";
import { fmtCi, fmtP, fmtInt, escapeHtml, hideTooltip } from "../charts/common";

let open = false;

export async function openDrawer(
  row: EstimateRow,
  selection: Selection,
  lookups: Lookups,
): Promise<void> {
  if (open) closeDrawer();
  open = true;
  hideTooltip();

  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  backdrop.addEventListener("click", closeDrawer);

  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", `Detail for ${row.outcome_name}`);

  const targetName = exposureName(lookups, selection.targetId);
  const comparatorName = exposureName(lookups, selection.comparatorId);

  drawer.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <h2>${escapeHtml(row.outcome_name)}</h2>
    <p class="muted small">
      ${escapeHtml(targetName)} vs ${escapeHtml(comparatorName)} ·
      ${escapeHtml(selection.databaseId)} · analysis ${selection.analysisId}
      ${row.is_negative_control ? '<span class="chip">negative control</span>' : ""}
    </p>

    <div class="panel">
      <h2>Estimate</h2>
      <div class="tiles" id="d-tiles"></div>
    </div>

    <div class="panel">
      <h2>Consistency across databases</h2>
      <p class="hint">The same comparison, outcome, and analysis run in each
        contributing database. Estimates that disagree across databases are a
        reason for caution regardless of any single one's confidence interval.</p>
      <div id="d-forest"></div>
    </div>

    <div class="panel">
      <h2>Kaplan-Meier survival</h2>
      <p class="hint">Time to first occurrence of this outcome in the
        propensity-score adjusted populations, with 95% bands.</p>
      <div id="d-km"></div>
    </div>

    <div class="panel">
      <h2>Follow-up time (days)</h2>
      <div id="d-followup"></div>
    </div>

    <div class="panel">
      <h2>Cohort attrition</h2>
      <p class="hint">Subjects remaining after each step of cohort construction,
        for this outcome's analysis.</p>
      <div id="d-attrition"></div>
    </div>
  `;

  drawer.querySelector(".close")?.addEventListener("click", closeDrawer);
  document.body.append(backdrop, drawer);
  document.addEventListener("keydown", onKey);

  tiles(drawer.querySelector("#d-tiles") as HTMLElement, row);

  const [across, km, followUp, attrition] = await Promise.all([
    loadOutcomeAcrossDatabases(selection, row.outcome_id),
    loadKaplanMeier(selection, row.outcome_id),
    loadFollowUp(selection, row.outcome_id),
    loadAttrition(selection, row.outcome_id),
  ]);

  if (!open) return;

  renderForest(
    drawer.querySelector("#d-forest") as HTMLElement,
    across.map((r) => ({
      label: r.database_id,
      rr: r.rr,
      lb: r.ci_95_lb,
      ub: r.ci_95_ub,
      p: r.p,
      calRr: r.cal_rr,
      calLb: r.cal_lb,
      calUb: r.cal_ub,
      calP: r.cal_p,
    })),
    { labelWidth: 120 },
  );

  renderKaplanMeier(drawer.querySelector("#d-km") as HTMLElement, km, {
    target: shortName(targetName),
    comparator: shortName(comparatorName),
  });

  const followUpEl = drawer.querySelector("#d-followup") as HTMLElement;
  if (followUp) {
    renderTable(
      followUpEl,
      [
        {
          group: shortName(targetName),
          p25: followUp.target_p25_days,
          median: followUp.target_median_days,
          p75: followUp.target_p75_days,
          max: followUp.target_max_days,
        },
        {
          group: shortName(comparatorName),
          p25: followUp.comparator_p25_days,
          median: followUp.comparator_median_days,
          p75: followUp.comparator_p75_days,
          max: followUp.comparator_max_days,
        },
      ],
      [
        { key: "group", label: "Group", value: (r) => r.group },
        { key: "p25", label: "P25", value: (r) => r.p25, numeric: true },
        { key: "median", label: "Median", value: (r) => r.median, numeric: true },
        { key: "p75", label: "P75", value: (r) => r.p75, numeric: true },
        { key: "max", label: "Max", value: (r) => r.max, numeric: true },
      ],
    );
  } else {
    followUpEl.innerHTML = `<p class="muted small">No follow-up distribution recorded.</p>`;
  }

  const attritionEl = drawer.querySelector("#d-attrition") as HTMLElement;
  if (attrition.length > 0) {
    renderTable(
      attritionEl,
      attrition,
      [
        {
          key: "exposure",
          label: "Cohort",
          value: (r) =>
            r.exposure_id === selection.targetId ? "Target" : "Comparator",
        },
        { key: "seq", label: "Step", value: (r) => r.sequence_number, numeric: true },
        { key: "description", label: "Description", value: (r) => r.description },
        {
          key: "subjects",
          label: "Subjects",
          value: (r) => r.subjects,
          numeric: true,
          render: (r) => fmtInt(r.subjects),
        },
      ],
      { sortKey: "seq", maxHeight: 320 },
    );
  } else {
    attritionEl.innerHTML = `<p class="muted small">No attrition recorded for this outcome.</p>`;
  }
}

function tiles(container: HTMLElement, row: EstimateRow): void {
  const items: [string, string, string][] = [
    [
      "Hazard ratio",
      fmtCi(row.rr, row.ci_95_lb, row.ci_95_ub),
      `p = ${fmtP(row.p)}`,
    ],
    [
      "Calibrated HR",
      fmtCi(row.cal_rr, row.cal_lb, row.cal_ub),
      `calibrated p = ${fmtP(row.cal_p)}`,
    ],
    [
      "Events (target)",
      fmtInt(row.target_outcomes),
      `${fmtInt(row.target_subjects)} subjects · ${fmtInt(row.target_days)} days`,
    ],
    [
      "Events (comparator)",
      fmtInt(row.comparator_outcomes),
      `${fmtInt(row.comparator_subjects)} subjects · ${fmtInt(row.comparator_days)} days`,
    ],
  ];
  container.innerHTML = items
    .map(
      ([label, value, sub]) =>
        `<div class="tile"><div class="label">${escapeHtml(label)}</div>
         <div class="value">${escapeHtml(value)}</div>
         <div class="sub">${escapeHtml(sub)}</div></div>`,
    )
    .join("");
}

function exposureName(lookups: Lookups, id: number): string {
  return (
    lookups.exposures.find((e) => e.exposure_id === id)?.exposure_name ??
    `Exposure ${id}`
  );
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeDrawer();
}

export function closeDrawer(): void {
  open = false;
  document.removeEventListener("keydown", onKey);
  document.querySelector(".drawer-backdrop")?.remove();
  document.querySelector(".drawer")?.remove();
  hideTooltip();
}
