/** Vite's `?raw` suffix, which tests use to read documentation that must agree with the code. */
declare module "*?raw" {
  const content: string;
  export default content;
}
