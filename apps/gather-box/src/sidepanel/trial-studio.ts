import { GatherController, type GatherControllerOptions } from "../shared/gather-controller";
import { REQUIRED_ELEMENT_IDS, TRIAL_CSS, TRIAL_LAYOUTS } from "./trial-layouts";

/**
 * Temporary design-trial studio: renders one of the candidate side panel
 * layouts into #trial-root and rebinds a fresh GatherController on each swap.
 * Delete this module (and trial-layouts.ts) once a winner is chosen.
 */

const STORAGE_KEY = "gather-box:trial-layout";

export function initTrialStudio(options: GatherControllerOptions): void {
  const root = document.getElementById("trial-root");
  if (!root) {
    throw new Error("Trial studio root element is missing.");
  }

  const style = document.createElement("style");
  style.textContent = TRIAL_CSS;
  document.head.appendChild(style);

  let activeController: GatherController | null = null;
  let swapChain: Promise<void> = Promise.resolve();

  const switcher = buildSwitcher((index) => {
    swapChain = swapChain.then(() => swap(index));
  });
  document.body.appendChild(switcher.nav);

  const swap = async (index: number): Promise<void> => {
    activeController?.destroy();
    activeController = null;

    const layout = TRIAL_LAYOUTS[index - 1];
    root.innerHTML = layout.html;
    document.body.dataset.trialLayout = String(index);
    verifyLayoutContract(index);
    switcher.setActive(index, layout.name);
    window.localStorage.setItem(STORAGE_KEY, String(index));

    const controller = new GatherController(options);
    activeController = controller;
    await controller.init(document);
  };

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const index = Number.parseInt(event.key, 10);
    if (index >= 1 && index <= TRIAL_LAYOUTS.length) {
      swapChain = swapChain.then(() => swap(index));
    }
  });

  swapChain = swapChain.then(() => swap(loadSavedLayoutIndex()));
}

function loadSavedLayoutIndex(): number {
  const saved = Number.parseInt(window.localStorage.getItem(STORAGE_KEY) ?? "", 10);
  return saved >= 1 && saved <= TRIAL_LAYOUTS.length ? saved : 1;
}

function verifyLayoutContract(index: number): void {
  for (const id of REQUIRED_ELEMENT_IDS) {
    const count = document.querySelectorAll(`[id="${id}"]`).length;
    if (count !== 1) {
      throw new Error(`Trial layout ${index} has ${count} elements with id "${id}" (expected 1).`);
    }
  }
}

interface Switcher {
  nav: HTMLElement;
  setActive: (index: number, name: string) => void;
}

function buildSwitcher(onSelect: (index: number) => void): Switcher {
  const nav = document.createElement("nav");
  nav.className = "trial-switcher";
  nav.setAttribute("aria-label", "Design trial layouts");

  const buttons: HTMLButtonElement[] = [];
  TRIAL_LAYOUTS.forEach((layout, position) => {
    const index = position + 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trial-switcher-btn";
    button.textContent = String(index);
    button.title = `${layout.name} — ${layout.tagline}`;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      onSelect(index);
    });
    buttons.push(button);
    nav.appendChild(button);
  });

  const name = document.createElement("span");
  name.className = "trial-switcher-name";
  nav.appendChild(name);

  return {
    nav,
    setActive: (index, layoutName) => {
      buttons.forEach((button, position) => {
        button.setAttribute("aria-pressed", position + 1 === index ? "true" : "false");
      });
      name.textContent = layoutName;
    }
  };
}
