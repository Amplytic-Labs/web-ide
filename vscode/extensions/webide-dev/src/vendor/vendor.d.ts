/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** esbuild 'text' loader asset: the vendored qrcode-generator source. */
declare module '*.qrjs' {
	const content: string;
	export default content;
}
