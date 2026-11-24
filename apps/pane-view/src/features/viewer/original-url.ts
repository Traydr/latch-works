/** The route that redirects a signed-in owner to the original file, on another origin. */
export function originalUrl(mediaId: string): string {
  return `/api/media/${mediaId}/original`;
}
