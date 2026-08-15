// Shared CSV building for anything backed by export_timesheet_report's row
// shape (ReportsPane's manager/admin export and the DSAR access-request
// export both need the identical column set and escaping rules).
export type TimesheetReportRow = {
  employee_name: string;
  department_name: string | null;
  session_date: string;
  clock_in: string;
  clock_out: string | null;
  duration_hours: number;
  cb_minutes: number;
  lb_minutes: number;
  violations: string | null;
  geofence: string;
};

const CSV_HEADERS = [
  "Employee",
  "Department",
  "Date",
  "Clock In",
  "Clock Out",
  "Duration (h)",
  "Paid Break (min)",
  "Lunch (min)",
  "Violations",
  "Geofence",
];

function csvEscape(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildTimesheetReportCsv(rows: TimesheetReportRow[]): string {
  const lines = [
    CSV_HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.employee_name,
        row.department_name,
        row.session_date,
        row.clock_in,
        row.clock_out,
        row.duration_hours,
        row.cb_minutes,
        row.lb_minutes,
        row.violations,
        row.geofence,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  return lines.join("\n");
}

export function downloadCsv(csvText: string, filename: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
