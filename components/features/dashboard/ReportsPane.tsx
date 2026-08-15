"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { computeCurrentPayCycleRange, type DateRange, type PayCycleType } from "@/lib/payCycle";
import { buildTimesheetReportCsv, downloadCsv, type TimesheetReportRow } from "@/lib/csv";
import { Button } from "@/components/ui/Button";
import styles from "./ReportsPane.module.css";

type Person = { id: string; name: string; departmentId: string | null };
type Department = { id: string; name: string };

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stepCycle(
  range: DateRange,
  direction: 1 | -1,
  payCycleType: PayCycleType,
  payCycleStartDate: string,
): DateRange {
  const referenceDate =
    direction === 1 ? new Date(range.end.getTime() + 1) : new Date(range.start.getTime() - 1);
  return computeCurrentPayCycleRange(payCycleType, payCycleStartDate, referenceDate);
}

export function ReportsPane({
  people,
  departments,
  payCycleType,
  payCycleStartDate,
}: {
  people: Person[];
  departments: Department[];
  payCycleType: PayCycleType;
  payCycleStartDate: string;
}) {
  const [cycleOffset, setCycleOffset] = useState(0);
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportedCount, setExportedCount] = useState<number | null>(null);

  let range = computeCurrentPayCycleRange(payCycleType, payCycleStartDate);
  const direction = cycleOffset > 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(cycleOffset); i++) {
    range = stepCycle(range, direction, payCycleType, payCycleStartDate);
  }

  const filteredPeople = departmentId ? people.filter((p) => p.departmentId === departmentId) : people;

  async function handleExport() {
    setIsExporting(true);
    setErrorMessage(null);
    setExportedCount(null);

    const supabase = createClient();
    const { data, error } = await callRpc<TimesheetReportRow[]>(supabase, "export_timesheet_report", {
      p_department_id: departmentId || null,
      p_employee_id: employeeId || null,
      p_range_start: toDateInputValue(range.start),
      p_range_end: toDateInputValue(range.end),
    });

    setIsExporting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    const rows = data ?? [];
    downloadCsv(
      buildTimesheetReportCsv(rows),
      `timesheet-report-${toDateInputValue(range.start)}-to-${toDateInputValue(range.end)}.csv`,
    );

    setExportedCount(rows.length);
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Department</span>
          <select
            className={styles.select}
            value={departmentId}
            onChange={(event) => {
              setDepartmentId(event.target.value);
              setEmployeeId("");
            }}
          >
            <option value="">All</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span>Employee</span>
          <select
            className={styles.select}
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
          >
            <option value="">All</option>
            {filteredPeople.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.field}>
          <span>Pay cycle</span>
          <div className={styles.cycleNav}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCycleOffset((offset) => offset - 1)}
            >
              ‹ Prev
            </Button>
            <span className={styles.range}>
              {range.start.toLocaleDateString()} – {range.end.toLocaleDateString()}
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCycleOffset((offset) => offset + 1)}
              disabled={cycleOffset >= 0}
            >
              Next ›
            </Button>
          </div>
        </div>
      </div>

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}
      {exportedCount !== null && !errorMessage && (
        <p className={styles.success}>
          {exportedCount === 0 ? "No sessions in this range." : `Exported ${exportedCount} row(s).`}
        </p>
      )}

      <Button type="button" onClick={handleExport} disabled={isExporting}>
        {isExporting ? "Exporting…" : "Export CSV"}
      </Button>
    </div>
  );
}
