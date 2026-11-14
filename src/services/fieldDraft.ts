// What a text field shows when its stored value changes underneath it.
//
// A save is sent 500 ms after the last keystroke, and the server's reply
// carries the value as it was when that save ran. If the person has typed
// on since, taking the reply would wipe the characters typed in the meantime.
// So a field being edited keeps its draft; the save that follows brings the
// stored value up to date. Once the field is left, the stored value wins.
export function draftAfterStoredChange(draft: string, stored: string, editing: boolean): string {
  return editing ? draft : stored;
}
