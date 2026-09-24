/**
 * The DOM lib declares these on every dialog; jsdom does not have them, so
 * callers read them as optional and fall back.
 */
type OptionalModalDialog = Partial<Pick<HTMLDialogElement, "showModal" | "close">>;

export function openDialog(dialog: HTMLDialogElement): void {
  const modal: OptionalModalDialog = dialog;

  if (modal.showModal) {
    modal.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

export function closeDialog(dialog: HTMLDialogElement): void {
  const modal: OptionalModalDialog = dialog;

  if (modal.close) {
    modal.close();
  } else {
    dialog.removeAttribute("open");
  }
}
