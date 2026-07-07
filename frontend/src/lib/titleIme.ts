export function shouldSkipTitleChange({
  eventIsComposing,
  isComposing,
}: {
  eventIsComposing?: boolean;
  isComposing: boolean;
}): boolean {
  return Boolean(eventIsComposing || isComposing);
}

export function shouldSyncTitleValue({
  inputValue,
  noteTitle,
  isComposing,
}: {
  inputValue: string;
  noteTitle: string;
  isComposing: boolean;
}): boolean {
  return !isComposing && inputValue !== noteTitle;
}

export function shouldEmitTitleUpdate({
  title,
  noteTitle,
  lastEmittedTitle,
}: {
  title: string;
  noteTitle: string;
  lastEmittedTitle: string;
}): boolean {
  return title !== noteTitle && title !== lastEmittedTitle;
}
