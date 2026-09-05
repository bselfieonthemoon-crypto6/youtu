export function preserveChatCopy(
  event: ClipboardEvent,
  root: HTMLElement,
  selection: Selection | null = window.getSelection(),
): boolean {
  const eventTarget = event.target;
  const activeElement = document.activeElement;
  const targetInside = eventTarget instanceof Node && root.contains(eventTarget);
  const activeInside = activeElement instanceof Node && root.contains(activeElement);
  const selectionInside =
    selection != null &&
    !selection.isCollapsed &&
    selection.anchorNode instanceof Node &&
    selection.focusNode instanceof Node &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode);

  if (!targetInside && !activeInside && !selectionInside) return false;

  // Excalidraw installs its own document-level copy listener. Stop it on the
  // same EventTarget before it can replace a chat-text selection with canvas
  // data. Inputs keep their native copy behavior; rendered messages are copied
  // explicitly as plain text for consistent embedded-browser behavior.
  event.stopImmediatePropagation();
  if (selectionInside) {
    event.clipboardData?.setData("text/plain", selection.toString());
    event.preventDefault();
  }
  return true;
}
