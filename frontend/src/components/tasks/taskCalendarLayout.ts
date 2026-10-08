/**
 * A month calendar must keep all seven columns aligned. Grouping its days into
 * independent week rows lets an empty week stay short while a busy week grows
 * naturally with its visible task cards (rather than stretching every week).
 */
export function groupCalendarDaysByWeek(days: readonly Date[]): Date[][] {
  const result: Date[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    result.push(days.slice(index, index + 7));
  }
  return result;
}
