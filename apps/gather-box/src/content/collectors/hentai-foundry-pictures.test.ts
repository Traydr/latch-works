// @vitest-environment jsdom
/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { collectHentaiFoundryPicturesData } from "./hentai-foundry-pictures";

const pictureUrl =
  "https://www.hentai-foundry.com/pictures/user/TheKite/1200030/Fallout-Unsheltered-Nuts-n-Bolts-06";

describe("Hentai Foundry picture collector", () => {
  it("does not mistake a thumbnail for the full-size picture", () => {
    const document = new DOMParser().parseFromString(
      '<section id="picBox"><div class="boxbody"><img src="//thumbs.hentai-foundry.com/thumb.php?pid=1"></div></section>',
      "text/html"
    );

    expect(
      collectHentaiFoundryPicturesData(document, new URL(pictureUrl) as unknown as Location)
    ).toMatchObject({ ok: false, code: "NO_VALID_IMAGES" });
  });
});
