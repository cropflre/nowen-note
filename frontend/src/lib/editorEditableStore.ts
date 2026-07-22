type EditableEditor = object & { isEditable: boolean };

type EditableState = {
  value: boolean;
  listeners: Set<() => void>;
};

const states = new WeakMap<object, EditableState>();

function getState(editor: EditableEditor): EditableState {
  let state = states.get(editor);
  if (!state) {
    state = { value: editor.isEditable, listeners: new Set() };
    states.set(editor, state);
  }
  return state;
}

export function getEditorEditableSnapshot(editor: EditableEditor): boolean {
  return getState(editor).value;
}

export function subscribeEditorEditable(editor: EditableEditor, listener: () => void): () => void {
  const state = getState(editor);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function publishEditorEditable(editor: EditableEditor): boolean {
  const state = getState(editor);
  const next = editor.isEditable;
  if (state.value === next) return false;
  state.value = next;
  for (const listener of state.listeners) listener();
  return true;
}
