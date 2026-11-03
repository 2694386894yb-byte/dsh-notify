/**
 * QR-code rendering for the login handshake, and the only module that imports the
 * `qrcode` package.
 *
 * Keeping the dependency behind explicit signatures matters for consumers: the
 * published `qrcode` typings are an ambient `declare module` in a sibling package
 * (DefinitelyTyped), and an ambient declaration in one workspace package does not
 * apply while another package type-checks. Declaring the two calls we use here
 * means every consumer sees a typed function instead of implicitly `any`.
 *
 * @module @dsh-wechat/core/render
 */
/**
 * Render a QR payload as a PNG data URL, ready for an `<img src>`.
 *
 * @param payload - The `qrcode_img_content` string from the login response.
 * @param size - Rendered width in pixels.
 * @returns A `data:image/png;base64,...` URL, or `undefined` if rendering failed.
 */
export declare function toDataUrl(payload: string, size?: number): Promise<string | undefined>;
/**
 * Render a QR payload as block characters.
 *
 * The result carries no colour escapes: it is meant for logs and terminal
 * transcripts, where ANSI codes only get in the way.
 *
 * @param payload - The `qrcode_img_content` string.
 * @returns Multi-line ASCII art, or `undefined` if rendering failed.
 */
export declare function toAscii(payload: string): Promise<string | undefined>;
//# sourceMappingURL=render.d.ts.map