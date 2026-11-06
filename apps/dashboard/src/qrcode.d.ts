/**
 * The one call this app makes into `qrcode`, declared here rather than taken from `@types/qrcode`.
 *
 * Those types open with `/// <reference types="node" />`, which put all of Node's globals into every
 * file of a browser app: `process.env`, `Buffer` and `__dirname` typechecked clean in code that throws
 * the moment a tab runs it. The dashboard uses `toDataURL` and nothing else, so that is what is said
 * here, and `tests/browser-types.test.ts` keeps Node's types out of the program.
 */
declare module "qrcode" {
  interface ToDataURLOptions {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }

  /** A PNG of `text` as a `data:` URL — the browser build draws it on a canvas of its own. */
  export function toDataURL(text: string, options?: ToDataURLOptions): Promise<string>;

  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
