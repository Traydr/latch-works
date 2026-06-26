const LAYOUT_STORAGE_KEY = "gather-box-layout-preview";

export function initLayoutSwitcher(document: Document): void {
  const main = document.querySelector<HTMLElement>("main.popup");
  const buttons = document.querySelectorAll<HTMLButtonElement>(".layout-switcher-btn");

  if (!main || buttons.length === 0) {
    return;
  }

  const stored = sessionStorage.getItem(LAYOUT_STORAGE_KEY);
  const initialLayout = stored && /^[1-5]$/.test(stored) ? stored : "1";
  applyLayout(main, buttons, initialLayout);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const layout = button.dataset.layout;
      if (!layout || !/^[1-5]$/.test(layout)) {
        return;
      }

      sessionStorage.setItem(LAYOUT_STORAGE_KEY, layout);
      applyLayout(main, buttons, layout);
    });
  }
}

function applyLayout(
  main: HTMLElement,
  buttons: NodeListOf<HTMLButtonElement>,
  layout: string
): void {
  main.dataset.layout = layout;

  for (const button of buttons) {
    button.classList.toggle("layout-switcher-btn-active", button.dataset.layout === layout);
    button.setAttribute("aria-pressed", button.dataset.layout === layout ? "true" : "false");
  }

  document.body.dataset.layout = layout;
}
