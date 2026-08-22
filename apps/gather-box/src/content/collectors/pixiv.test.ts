// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { collectPixivData } from "./pixiv";

const ARTWORK_ID = "146518851";
const CREATOR_ID = "12332292";
const PAGE_URL = new URL(`https://www.pixiv.net/en/artworks/${ARTWORK_ID}`);
const ORIGINAL_URL =
  `https://i.pximg.net/img-original/img/2026/06/27/17/10/36/${ARTWORK_ID}_p0.png`;

function createPixivDocument(creatorName: string, requestStatus?: string): Document {
  const document = new DOMParser().parseFromString(
    `<section><h1>Artwork</h1><a href="${ORIGINAL_URL}"></a></section>`,
    "text/html"
  );
  const artworkSection = document.querySelector("section");
  if (!artworkSection) {
    throw new Error("Pixiv fixture is missing its artwork section.");
  }

  const profileLink = document.createElement("a");
  profileLink.href = `/en/users/${CREATOR_ID}`;

  const nameElement = document.createElement("div");
  nameElement.textContent = creatorName;
  profileLink.append(nameElement);

  if (requestStatus) {
    // Pixiv creates this nested anchor through JavaScript. An HTML parser would move it outside
    // the profile link and hide the production bug that this fixture covers.
    const requestLink = document.createElement("a");
    requestLink.href = `/users/${CREATOR_ID}/request`;
    requestLink.textContent = requestStatus;
    profileLink.append(requestLink);
  }

  artworkSection.append(profileLink);
  return document;
}

describe("Pixiv collector", () => {
  it("keeps request status text out of the creator folder", () => {
    const result = collectPixivData(createPixivDocument("rx", "Requests closed"), PAGE_URL);

    expect(result).toMatchObject({
      ok: true,
      folderSegments: [`rx-${CREATOR_ID}`]
    });
  });

  it("keeps a plain creator name", () => {
    const result = collectPixivData(createPixivDocument("Artist"), PAGE_URL);

    expect(result).toMatchObject({
      ok: true,
      folderSegments: [`Artist-${CREATOR_ID}`]
    });
  });
});
