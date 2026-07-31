import type { JSX } from "react";
import { PdfDocument, type PdfDocumentProps } from "./PdfDocument";

export function PdfViewer(props: PdfDocumentProps): JSX.Element {
  return <PdfDocument key={props.mediaId} {...props} />;
}
