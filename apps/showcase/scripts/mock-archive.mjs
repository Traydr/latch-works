/**
 * A stand-in for Archive of Our Own, so the Gather Box capture never loads the real site, which
 * refuses automated browsers. The capture's content tab keeps AO3's real URLs, so Gather Box picks
 * its AO3 collector as it does on the site, while every request to archiveofourown.org is
 * answered here. The work page carries the markup the collector reads (the title, the byline's
 * author link, and the PDF download link); the work itself is made up.
 */

const archiveHost = "archiveofourown.org";

/** The made-up work's URL. */
export const mockWorkUrl = `https://${archiveHost}/works/10000001`;

/** The site's home page, which Gather Box shows as an unsupported page. */
export const mockHomeUrl = `https://${archiveHost}/`;

const styles = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #2a2a2a;
         font: 15px/1.5 "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, sans-serif; }
  a { color: #111; }
  #header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; }
  #header .logo { font: 36px Georgia, serif; color: #900; text-decoration: none; }
  #header .login { font-size: 15px; }
  nav.primary { display: flex; gap: 22px; align-items: center; background: #900; padding: 6px 40px;
                box-shadow: inset 0 -6px 10px rgba(0, 0, 0, 0.2); }
  nav.primary a { color: #fff; text-decoration: none; font-size: 15px; }
  nav.primary .search { margin-left: auto; display: flex; gap: 6px; }
  nav.primary input { width: 200px; border: 0; border-radius: 14px; padding: 5px 10px; }
  nav.primary button { border: 1px solid #bbb; border-radius: 4px; background: #eee; padding: 3px 10px; }
  #main { padding: 18px 40px 40px; }
  ul.work.navigation { list-style: none; display: flex; justify-content: flex-end; gap: 8px;
                       margin: 0 0 14px; padding: 0; }
  ul.work.navigation li a { display: block; border: 1px solid #bbb; border-radius: 4px;
                            background: linear-gradient(#fff, #ddd); padding: 3px 12px;
                            text-decoration: none; }
  dl.work.meta { display: grid; grid-template-columns: 220px 1fr; gap: 6px 12px; margin: 0;
                 border: 1px solid #ddd; padding: 16px; box-shadow: 1px 1px 5px #aaa; }
  dl.work.meta dt { font-weight: normal; }
  dl.work.meta dd { margin: 0; }
  dl.work.meta dd a { margin-right: 10px; }
  #workskin { max-width: 860px; margin: 32px auto 0; }
  h2.title.heading { font: 34px Georgia, serif; text-align: center; margin: 0 0 6px; }
  h3.byline.heading { font: 22px Georgia, serif; text-align: center; margin: 0 0 22px; }
  h3.byline.heading a { text-decoration: none; }
  .summary h3 { font: 20px Georgia, serif; border-bottom: 1px solid #333; margin: 0 0 8px; }
  .summary blockquote, .userstuff { margin: 0 0 18px 14px; }
`;

const header = `
  <div id="header">
    <a class="logo" href="/">Archive of Our Own</a>
    <a class="login" href="/users/login">Log In</a>
  </div>
  <nav class="primary">
    <a href="/media">Fandoms</a><a href="/menu/browse">Browse</a><a href="/menu/search">Search</a>
    <a href="/menu/about">About</a>
    <span class="search"><input aria-label="Work search" /><button type="button">Search</button></span>
  </nav>`;

const workHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>The Lighthouse Ledger - sample_author - Original Work [Archive of Our Own]</title>
<style>${styles}</style></head>
<body>
  ${header}
  <div id="main">
    <ul class="work navigation actions">
      <li><a href="#comments">Comments</a></li>
      <li><a href="#share">Share</a></li>
      <li class="download"><a href="#download">Download</a>
        <ul hidden>
          <li><a href="/downloads/10000001/The_Lighthouse_Ledger.pdf?updated_at=1">PDF</a></li>
        </ul>
      </li>
    </ul>
    <dl class="work meta group">
      <dt>Rating:</dt><dd><a href="#">General Audiences</a></dd>
      <dt>Archive Warning:</dt><dd><a href="#">No Archive Warnings Apply</a></dd>
      <dt>Category:</dt><dd><a href="#">Gen</a></dd>
      <dt>Fandom:</dt><dd><a href="#">Original Work</a></dd>
      <dt>Additional Tags:</dt>
      <dd><a href="#">Lighthouses</a><a href="#">Found Family</a><a href="#">Slow Burn</a>
        <a href="#">Weather</a></dd>
      <dt>Language:</dt><dd>English</dd>
      <dt>Stats:</dt><dd>Published: 2026-03-14 &nbsp; Words: 4,812 &nbsp; Chapters: 1/1</dd>
    </dl>
    <div id="workskin">
      <h2 class="title heading">The Lighthouse Ledger</h2>
      <h3 class="byline heading"><a rel="author" href="/users/sample_author">sample_author</a></h3>
      <div class="summary module">
        <h3>Summary:</h3>
        <blockquote class="userstuff"><p>Every ship that passes the point goes into the keeper's
          ledger. One night a ship sails past that is already in it.</p></blockquote>
      </div>
      <div class="userstuff">
        <p>The fog came in at four, as it always did in October, and Ada lit the lamp an hour early
          so she would not have to climb the stairs in the dark.</p>
      </div>
    </div>
  </div>
</body></html>`;

const homeHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Archive of Our Own</title><style>${styles}</style></head>
<body>
  ${header}
  <div id="main">
    <h2 class="title heading">A fan-created, fan-run, nonprofit archive for fanworks</h2>
  </div>
</body></html>`;

/**
 * Answers the page's requests to archiveofourown.org from the mock: the work page and the home
 * page as documents, anything else as an empty 404. Requests to other hosts go through unchanged.
 */
export async function serveMockArchive(page) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.hostname !== archiveHost) {
      void request.continue();

      return;
    }

    const body = url.pathname.startsWith("/works/")
      ? workHtml
      : url.pathname === "/"
        ? homeHtml
        : null;

    void request.respond(
      body === null
        ? { status: 404, body: "" }
        : { status: 200, contentType: "text/html; charset=utf-8", body },
    );
  });
}
