import { PDF, rgb, type EmbeddedFont, type PDFPage } from "@libpdf/core";
import type { GeneratedStoryPayload, StoryChapterReference } from "../shared/types";

const PAGE_SIZE = "letter";
const MARGIN = 54;
const BODY_FONT_SIZE = 11;
const BODY_LINE_HEIGHT = BODY_FONT_SIZE * 1.35;
const TITLE_FONT_SIZE = 22;
const CHAPTER_FONT_SIZE = 16;
const META_FONT_SIZE = 9;
const META_LINE_HEIGHT = META_FONT_SIZE * 1.35;
const PARAGRAPH_GAP = BODY_LINE_HEIGHT * 0.65;
const CHAPTER_GAP = BODY_LINE_HEIGHT;
const CHAPTER_FETCH_DELAY_MS = 200;

export interface FanfictionStoryCallbacks {
  onStart(total: number): void;
  onChapterFetched(completed: number, total: number, chapter: StoryChapterReference): void;
  onGenerating(): void;
  onSaved(fileName: string): void;
}

interface StoryChapterContent {
  reference: StoryChapterReference;
  blocks: StoryBlock[];
}

interface StoryBlock {
  kind: "paragraph" | "blank";
  runs: StoryTextRun[];
}

interface StoryTextRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface PdfFonts {
  regular: EmbeddedFont;
  italic: EmbeddedFont;
  bold: EmbeddedFont;
  boldItalic: EmbeddedFont;
}

interface PdfCursor {
  pdf: PDF;
  page: PDFPage;
  fonts: PdfFonts;
  x: number;
  y: number;
  maxWidth: number;
  bottom: number;
  top: number;
}

interface TextToken {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface TextLine {
  tokens: TextToken[];
  width: number;
}

export async function saveFanfictionStoryPdf(
  payload: GeneratedStoryPayload,
  destinationDirectory: FileSystemDirectoryHandle,
  callbacks: FanfictionStoryCallbacks
): Promise<void> {
  callbacks.onStart(payload.chapters.length);
  const chapters = await fetchChapterContents(payload, callbacks);

  callbacks.onGenerating();
  const bytes = await buildStoryPdf(payload, chapters);
  const pdfBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(pdfBytes).set(bytes);
  const fileHandle = await destinationDirectory.getFileHandle(payload.fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new Blob([pdfBytes], { type: "application/pdf" }));
  await writable.close();
  callbacks.onSaved(payload.fileName);
}

export async function fetchChapterContents(
  payload: GeneratedStoryPayload,
  callbacks: FanfictionStoryCallbacks
): Promise<StoryChapterContent[]> {
  const chapters: StoryChapterContent[] = [];
  const parser = new DOMParser();

  for (const [index, chapter] of payload.chapters.entries()) {
    if (index > 0) {
      await delay(CHAPTER_FETCH_DELAY_MS);
    }

    const response = await fetch(chapter.url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Failed ${chapter.label}: HTTP ${response.status}`);
    }

    const html = await response.text();
    const document = parser.parseFromString(html, "text/html");
    const storyText = document.querySelector("#storytext");
    if (!storyText) {
      throw new Error(`Failed ${chapter.label}: story text was not found.`);
    }

    chapters.push({
      reference: chapter,
      blocks: extractStoryBlocks(storyText)
    });
    callbacks.onChapterFetched(index + 1, payload.chapters.length, chapter);
  }

  return chapters;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export function extractStoryBlocks(storyText: Element): StoryBlock[] {
  const blocks: StoryBlock[] = [];

  for (const child of Array.from(storyText.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      const tagName = element.tagName.toLowerCase();
      if (tagName === "script" || tagName === "style") {
        continue;
      }

      if (tagName === "br") {
        blocks.push({ kind: "blank", runs: [] });
        continue;
      }

      const runs = normalizeRuns(collectRuns(element, false, false));
      blocks.push(runs.length > 0 ? { kind: "paragraph", runs } : { kind: "blank", runs: [] });
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE) {
      const runs = normalizeRuns([{ text: child.textContent || "", bold: false, italic: false }]);
      if (runs.length > 0) {
        blocks.push({ kind: "paragraph", runs });
      }
    }
  }

  return blocks;
}

function collectRuns(node: Node, bold: boolean, italic: boolean): StoryTextRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    return [{ text: normalizeTextNode(node.textContent || ""), bold, italic }];
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "script" || tagName === "style") {
    return [];
  }

  if (tagName === "br") {
    return [{ text: "\n", bold, italic }];
  }

  const nextBold = bold || tagName === "strong" || tagName === "b";
  const nextItalic = italic || tagName === "em" || tagName === "i";

  return Array.from(element.childNodes).flatMap((child) => collectRuns(child, nextBold, nextItalic));
}

function normalizeRuns(runs: StoryTextRun[]): StoryTextRun[] {
  const normalized: StoryTextRun[] = [];

  for (const run of runs) {
    const text = run.text.replace(/[^\S\n]+/g, " ");
    if (!text) {
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && previous.bold === run.bold && previous.italic === run.italic) {
      previous.text += text;
    } else {
      normalized.push({ ...run, text });
    }
  }

  trimRuns(normalized);
  return normalized.filter((run) => run.text.length > 0);
}

function trimRuns(runs: StoryTextRun[]): void {
  while (runs.length > 0) {
    runs[0].text = runs[0].text.replace(/^[^\S\n]+/, "");
    if (runs[0].text) {
      break;
    }
    runs.shift();
  }

  while (runs.length > 0) {
    const lastRun = runs[runs.length - 1];
    lastRun.text = lastRun.text.replace(/[^\S\n]+$/, "");
    if (lastRun.text) {
      break;
    }
    runs.pop();
  }
}

function normalizeTextNode(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

async function buildStoryPdf(
  payload: GeneratedStoryPayload,
  chapters: StoryChapterContent[]
): Promise<Uint8Array> {
  const pdf = PDF.create();
  pdf.setTitle(payload.title);
  pdf.setAuthor(payload.author);
  pdf.setSubject(payload.pageUrl);
  pdf.setCreator("Gather Box");
  pdf.setProducer("@libpdf/core");

  const fonts = await loadFonts(pdf);
  const page = pdf.addPage({ size: PAGE_SIZE });
  const cursor: PdfCursor = {
    pdf,
    page,
    fonts,
    x: MARGIN,
    y: page.height - MARGIN,
    maxWidth: page.width - MARGIN * 2,
    bottom: MARGIN,
    top: page.height - MARGIN
  };

  drawMetadata(cursor, payload);

  for (const [index, chapter] of chapters.entries()) {
    if (index > 0 || cursor.y < cursor.top - 190) {
      addPage(cursor);
    } else {
      cursor.y -= CHAPTER_GAP;
    }

    drawWrappedPlainText(cursor, chapter.reference.label, CHAPTER_FONT_SIZE, CHAPTER_FONT_SIZE * 1.35, "bold");
    cursor.y -= CHAPTER_GAP * 0.5;

    for (const block of chapter.blocks) {
      if (block.kind === "blank") {
        ensureSpace(cursor, BODY_LINE_HEIGHT);
        cursor.y -= BODY_LINE_HEIGHT;
        continue;
      }

      drawRichParagraph(cursor, block.runs);
      cursor.y -= PARAGRAPH_GAP;
    }
  }

  return pdf.save();
}

async function loadFonts(pdf: PDF): Promise<PdfFonts> {
  const [regular, italic, bold, boldItalic] = await Promise.all([
    loadFont(pdf, "assets/fonts/NotoSerif-Regular.ttf"),
    loadFont(pdf, "assets/fonts/NotoSerif-Italic.ttf"),
    loadFont(pdf, "assets/fonts/NotoSerif-Bold.ttf"),
    loadFont(pdf, "assets/fonts/NotoSerif-BoldItalic.ttf")
  ]);

  return { regular, italic, bold, boldItalic };
}

async function loadFont(pdf: PDF, path: string): Promise<EmbeddedFont> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`Could not load PDF font ${path}: HTTP ${response.status}`);
  }

  return pdf.embedFont(new Uint8Array(await response.arrayBuffer()));
}

function drawMetadata(cursor: PdfCursor, payload: GeneratedStoryPayload): void {
  drawWrappedPlainText(cursor, payload.title, TITLE_FONT_SIZE, TITLE_FONT_SIZE * 1.25, "bold");
  cursor.y -= META_LINE_HEIGHT;
  drawWrappedPlainText(cursor, `By ${payload.author}`, BODY_FONT_SIZE, BODY_LINE_HEIGHT, "regular");
  cursor.y -= META_LINE_HEIGHT;

  const metadataLines = [
    `Source: ${payload.pageUrl}`,
    `Story ID: ${payload.storyId}`,
    `Chapters: ${payload.chapters.length}`,
    payload.metadataLine,
    payload.summary
  ].filter(Boolean);

  for (const line of metadataLines) {
    drawWrappedPlainText(cursor, line, META_FONT_SIZE, META_LINE_HEIGHT, "regular", true);
  }
}

function drawRichParagraph(cursor: PdfCursor, runs: StoryTextRun[]): void {
  const lines = layoutRuns(runs, cursor.fonts, BODY_FONT_SIZE, cursor.maxWidth);

  for (const line of lines) {
    ensureSpace(cursor, BODY_LINE_HEIGHT);
    let x = cursor.x;

    for (const token of line.tokens) {
      if (!/^\s+$/.test(token.text)) {
        cursor.page.drawText(token.text, {
          x,
          y: cursor.y,
          size: BODY_FONT_SIZE,
          font: getFont(cursor.fonts, token),
          color: rgb(0, 0, 0)
        });
      }

      x += getFont(cursor.fonts, token).widthOfTextAtSize(token.text, BODY_FONT_SIZE);
    }

    cursor.y -= BODY_LINE_HEIGHT;
  }
}

function drawWrappedPlainText(
  cursor: PdfCursor,
  text: string,
  size: number,
  lineHeight: number,
  weight: "regular" | "bold",
  muted = false
): void {
  const font = weight === "bold" ? cursor.fonts.bold : cursor.fonts.regular;
  const runs: StoryTextRun[] = [{ text, bold: weight === "bold", italic: false }];
  const lines = layoutRuns(runs, cursor.fonts, size, cursor.maxWidth);

  for (const line of lines) {
    ensureSpace(cursor, lineHeight);
    let x = cursor.x;

    for (const token of line.tokens) {
      if (!/^\s+$/.test(token.text)) {
        cursor.page.drawText(token.text, {
          x,
          y: cursor.y,
          size,
          font,
          color: muted ? rgb(0.28, 0.28, 0.28) : rgb(0, 0, 0)
        });
      }

      x += font.widthOfTextAtSize(token.text, size);
    }

    cursor.y -= lineHeight;
  }
}

function layoutRuns(
  runs: StoryTextRun[],
  fonts: PdfFonts,
  fontSize: number,
  maxWidth: number
): TextLine[] {
  const lines: TextLine[] = [];
  let currentTokens: TextToken[] = [];
  let currentWidth = 0;

  const pushLine = (): void => {
    trimLineTokens(currentTokens);
    if (currentTokens.length > 0) {
      lines.push({
        tokens: currentTokens,
        width: currentTokens.reduce(
          (width, token) => width + getFont(fonts, token).widthOfTextAtSize(token.text, fontSize),
          0
        )
      });
    } else {
      lines.push({ tokens: [], width: 0 });
    }
    currentTokens = [];
    currentWidth = 0;
  };

  for (const run of runs) {
    for (const part of tokenize(run.text)) {
      if (part === "\n") {
        pushLine();
        continue;
      }

      if (/^\s+$/.test(part) && currentTokens.length === 0) {
        continue;
      }

      const token = { text: part, bold: run.bold, italic: run.italic };
      const tokenWidth = getFont(fonts, token).widthOfTextAtSize(token.text, fontSize);
      if (currentTokens.length > 0 && currentWidth + tokenWidth > maxWidth) {
        pushLine();
        if (/^\s+$/.test(part)) {
          continue;
        }
      }

      currentTokens.push(token);
      currentWidth += tokenWidth;
    }
  }

  trimLineTokens(currentTokens);
  if (currentTokens.length > 0 || lines.length === 0) {
    lines.push({ tokens: currentTokens, width: currentWidth });
  }

  return lines;
}

function tokenize(text: string): string[] {
  return text.match(/\n|[^\S\n]+|[^\s]+/g) || [];
}

function trimLineTokens(tokens: TextToken[]): void {
  while (tokens.length > 0 && /^\s+$/.test(tokens[0].text)) {
    tokens.shift();
  }

  while (tokens.length > 0 && /^\s+$/.test(tokens[tokens.length - 1].text)) {
    tokens.pop();
  }
}

function ensureSpace(cursor: PdfCursor, lineHeight: number): void {
  if (cursor.y - lineHeight < cursor.bottom) {
    addPage(cursor);
  }
}

function addPage(cursor: PdfCursor): void {
  cursor.page = cursor.pdf.addPage({ size: PAGE_SIZE });
  cursor.y = cursor.page.height - MARGIN;
  cursor.maxWidth = cursor.page.width - MARGIN * 2;
  cursor.top = cursor.page.height - MARGIN;
}

function getFont(fonts: PdfFonts, style: { bold: boolean; italic: boolean }): EmbeddedFont {
  if (style.bold && style.italic) {
    return fonts.boldItalic;
  }

  if (style.bold) {
    return fonts.bold;
  }

  if (style.italic) {
    return fonts.italic;
  }

  return fonts.regular;
}
