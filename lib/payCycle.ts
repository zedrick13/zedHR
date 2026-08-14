// SPEC §11 open item 5: pay-cycle range math needs one worked example per
// cycle type confirmed by Zed before M5. This is a best-effort
// implementation for M3's /timesheet self-view in the meantime — weekly/
// biweekly are fixed-length windows anchored to pay_cycle_start_date;
// monthly repeats on that date's day-of-month.
export type PayCycleType = "weekly" | "biweekly" | "monthly";

export type DateRange = { start: Date; end: Date };

const MS_PER_DAY = 86_400_000;

export function computeCurrentPayCycleRange(
  payCycleType: PayCycleType,
  anchorDateStr: string,
  referenceDate: Date = new Date(),
): DateRange {
  const anchor = new Date(`${anchorDateStr.slice(0, 10)}T00:00:00`);

  if (payCycleType === "weekly" || payCycleType === "biweekly") {
    const periodDays = payCycleType === "weekly" ? 7 : 14;
    const daysSinceAnchor = Math.floor((referenceDate.getTime() - anchor.getTime()) / MS_PER_DAY);
    const periodsElapsed = Math.floor(daysSinceAnchor / periodDays);
    const start = new Date(anchor.getTime() + periodsElapsed * periodDays * MS_PER_DAY);
    const end = new Date(start.getTime() + periodDays * MS_PER_DAY - 1);
    return { start, end };
  }

  const anchorDay = anchor.getDate();
  let start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), anchorDay);
  if (start.getTime() > referenceDate.getTime()) {
    start = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 1, anchorDay);
  }
  const end = new Date(start.getFullYear(), start.getMonth() + 1, anchorDay - 1, 23, 59, 59, 999);
  return { start, end };
}
