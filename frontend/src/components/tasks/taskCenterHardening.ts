export function shouldConfirmHabitDelete(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest("button");
  return !!button?.closest('[data-nowen-habit-row="true"]')
    && !!button.querySelector(".lucide-trash-2");
}
