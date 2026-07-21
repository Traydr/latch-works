// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectHentaiFoundryPicturesData,
  lowercaseFirstAscii
} from "./hentai-foundry-pictures";

const fixturePath = resolve(process.cwd(), "site-htmls/hentaifoundry-com-picture.html");
const pictureUrl =
  "https://www.hentai-foundry.com/pictures/user/TheKite/1200030/Fallout-Unsheltered-Nuts-n-Bolts-06";

describe("Hentai Foundry picture collector", () => {
  it("downloads the full-size site-named media under the normalized artist", () => {
    const document = new DOMParser().parseFromString(readFileSync(fixturePath, "utf8"), "text/html");
    const location = new URL(pictureUrl) as unknown as Location;

    const result = collectHentaiFoundryPicturesData(document, location);

    expect(result).toMatchObject({
      ok: true,
      outputKind: "downloadable-files",
      site: "hentaifoundry-pictures",
      title: "Fallout Unsheltered: Nuts n' Bolts! 06",
      galleryId: "1200030",
      folderSegments: ["theKite"],
      images: [
        {
          thumbnailUrl: "https://thumbs.hentai-foundry.com/thumb.php?pid=1200030&size=1250",
          originalUrl:
            "https://pictures.hentai-foundry.com/t/TheKite/1200030/TheKite-1200030-Fallout_Unsheltered_Nuts_n_Bolts_06.png",
          fileName: "TheKite-1200030-Fallout_Unsheltered_Nuts_n_Bolts_06.png"
        }
      ]
    });
  });

  it("does not mistake a thumbnail for the full-size picture", () => {
    const document = new DOMParser().parseFromString(
      '<section id="picBox"><div class="boxbody"><img src="//thumbs.hentai-foundry.com/thumb.php?pid=1"></div></section>',
      "text/html"
    );

    expect(
      collectHentaiFoundryPicturesData(document, new URL(pictureUrl) as unknown as Location)
    ).toMatchObject({ ok: false, code: "NO_VALID_IMAGES" });
  });

  it("lowercases only an initial ASCII capital in the artist name", () => {
    expect(lowercaseFirstAscii("TheKite")).toBe("theKite");
    expect(lowercaseFirstAscii("_TheKite")).toBe("_TheKite");
  });
});
