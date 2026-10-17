import { requireElement } from "../gather/dom";
import { formatError, toError } from "../gather/errors";
import {
  addProfile,
  DEFAULT_PROFILE_ID,
  getProfileName,
  loadProfiles,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILES,
  PROFILES_KEY,
  removeProfile,
  renameProfile,
  setActiveProfile,
  updateProfiles,
  type GatherProfilesState
} from "../shared/profiles";

interface ProfileEditorElements {
  rows: HTMLElement;
  addButton: HTMLButtonElement;
  status: HTMLElement;
}

/**
 * Profile edits write straight to storage; the settings form's Save button does not cover them.
 * The background forgets a deleted profile's folders, whichever page or device deleted it.
 */
export async function initProfileEditor(document: Document): Promise<void> {
  const elements: ProfileEditorElements = {
    rows: requireElement(document, "profileRows", HTMLElement),
    addButton: requireElement(document, "addProfile", HTMLButtonElement),
    status: requireElement(document, "profileStatus", HTMLElement)
  };

  let statusTimer: number | undefined;
  /** The state the rows show, so the echo of this page's own write does not redraw them. */
  let shownState = "";

  const render = (state: GatherProfilesState) => {
    renderRows(elements, state);
    shownState = JSON.stringify(state);
  };

  const report = (message: string) => {
    elements.status.textContent = message;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      elements.status.textContent = "";
    }, 2500);
  };

  const apply = async (
    change: (state: GatherProfilesState) => GatherProfilesState,
    message: string
  ): Promise<GatherProfilesState | null> => {
    try {
      const next = await updateProfiles(change);
      render(next);
      report(message);

      return next;
    } catch (error) {
      report(`Could not save profiles: ${formatError(toError(error))}`);

      return null;
    }
  };

  elements.addButton.addEventListener("click", () => {
    void apply((state) => addProfile(state, crypto.randomUUID()), "Profile added.").then((next) => {
      // Select the new profile's placeholder name so it can be typed over straight away.
      if (next) {
        const inputs = elements.rows.querySelectorAll<HTMLInputElement>("input[data-profile-id]");
        inputs[inputs.length - 1]?.select();
      }
    });
  });

  elements.rows.addEventListener("change", (event) => {
    const input = event.target;

    if (input instanceof HTMLInputElement && input.dataset.profileId) {
      const profileId = input.dataset.profileId;
      void apply((state) => renameProfile(state, profileId, input.value), "Profile renamed.");
    }
  });

  elements.rows.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.target.blur();
    }
  });

  elements.rows.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-action]")
        : null;

    const profileId = button?.dataset.profileId;

    if (!button || !profileId) {
      return;
    }

    if (button.dataset.action === "activate") {
      void apply((state) => setActiveProfile(state, profileId), "Profile switched.");

      return;
    }

    void deleteProfile(profileId);
  });

  const deleteProfile = async (profileId: string) => {
    const name = getProfileName(await loadProfiles(), profileId) ?? "this profile";

    const confirmed = window.confirm(
      `Delete "${name}"? Gather Box forgets the folders it remembers and drops pages still ` +
        "queued for them. Files already saved stay on disk."
    );

    if (confirmed) {
      await apply((current) => removeProfile(current, profileId), "Profile deleted.");
    }
  };

  // The side panel switches profiles too. Skip the redraw while a name is being typed.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[PROFILES_KEY]) {
      return;
    }

    void loadProfiles().then((state) => {
      const typing =
        document.activeElement instanceof HTMLInputElement &&
        elements.rows.contains(document.activeElement);

      if (!typing && JSON.stringify(state) !== shownState) {
        render(state);
      }
    });
  });

  render(await loadProfiles());
}

function renderRows(elements: ProfileEditorElements, state: GatherProfilesState): void {
  const rows = state.profiles.map((profile, index) => {
    const row = document.createElement("div");
    row.className = "profile-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = profile.name;
    input.maxLength = MAX_PROFILE_NAME_LENGTH;
    input.dataset.profileId = profile.id;
    input.setAttribute("aria-label", `Name of profile ${index + 1}`);

    let activeControl: HTMLElement;

    if (profile.id === state.activeProfileId) {
      activeControl = document.createElement("span");
      activeControl.className = "profile-active";
      activeControl.textContent = "Active";
    } else {
      activeControl = actionButton("Use", "activate", profile.id);
      activeControl.setAttribute("aria-label", `Use ${profile.name}`);
    }

    const remove = actionButton("Delete", "delete", profile.id);
    remove.setAttribute("aria-label", `Delete ${profile.name}`);

    // Folders remembered before profiles existed belong to the default profile, so it stays.
    if (profile.id === DEFAULT_PROFILE_ID) {
      remove.disabled = true;
      remove.title = "The default profile keeps folders remembered before profiles existed.";
    }

    row.append(input, activeControl, remove);

    return row;
  });

  elements.rows.replaceChildren(...rows);
  elements.addButton.disabled = state.profiles.length >= MAX_PROFILES;
}

function actionButton(label: string, action: string, profileId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.profileId = profileId;

  return button;
}
