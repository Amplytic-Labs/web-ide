/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPickAndOpenOptions, ISaveDialogOptions, IOpenDialogOptions, IFileDialogService, FileFilter, IPromptButton } from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractFileDialogService } from './abstractFileDialogService.js';
import { Schemas } from '../../../../base/common/network.js';
import { memoize } from '../../../../base/common/decorators.js';
import { HTMLFileSystemProvider } from '../../../../platform/files/browser/htmlFileSystemProvider.js';
import { localize } from '../../../../nls.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { getActiveWindow, triggerDownload, triggerUpload } from '../../../../base/browser/dom.js';
import Severity from '../../../../base/common/severity.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { extractFileListData } from '../../../../platform/dnd/browser/dnd.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { WebFileSystemAccess } from '../../../../platform/files/browser/webFileSystemAccess.js';
import { EmbeddedCodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { IWorkspaceEditingService } from '../../workspaces/common/workspaceEditing.js';

export class FileDialogService extends AbstractFileDialogService implements IFileDialogService {

	@memoize
	private get fileSystemProvider(): HTMLFileSystemProvider {
		return this.fileService.getProvider(Schemas.file) as HTMLFileSystemProvider;
	}

	async pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFileFolderAndOpenSimplified(schema, options, false);
		}

		throw new Error(localize('pickFolderAndOpen', "Can't open folders, try adding a folder to the workspace instead."));
	}

	protected override addFileSchemaIfNeeded(schema: string, isFolder: boolean): string[] {
		return (schema === Schemas.untitled) ? [Schemas.file]
			: (((schema !== Schemas.file) && (!isFolder || (schema !== Schemas.vscodeRemote))) ? [schema, Schemas.file] : [schema]);
	}

	async pickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFileAndOpenSimplified(schema, options, false);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('open');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		try {
			([fileHandle] = await activeWindow.showOpenFilePicker({ multiple: false }));
		} catch (error) {
			return; // `showOpenFilePicker` will throw an error when the user cancels
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return;
		}

		const uri = await this.fileSystemProvider.registerFileHandle(fileHandle);

		this.addFileToRecentlyOpened(uri);

		await this.openerService.open(uri, { fromUserGesture: true, editorOptions: { pinned: true } });
	}

	async pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFolderPath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFolderAndOpenSimplified(schema, options);
		}

		const activeWindow = this.getFilePickerWindow();
		if (WebFileSystemAccess.supported(activeWindow)) {
			// Native flow: File System Access folder picker → workspace over the handle
			const startIn = await this.getFilePickerStartIn(options.defaultUri) ?? 'documents';
			try {
				const handle = await activeWindow.showDirectoryPicker({ ...{ startIn } });
				const uri = await this.fileSystemProvider.registerDirectoryHandle(handle);
				return this.hostService.openWindow([{ folderUri: uri }], { forceNewWindow: options.forceNewWindow, remoteAuthority: options.remoteAuthority });
			} catch (error) {
				return; // user cancelled the picker
			}
		}

		// nodine: Fallback for browsers without showDirectoryPicker (Brave with
		// strict fingerprinting shields, Firefox, Safari) — the bolt.diy flow:
		// a hidden <input webkitdirectory> selects a folder, files are filtered
		// (node_modules & friends are NEVER imported) and copied into an
		// in-browser workspace, which then opens as a normal folder.
		return this.pickFolderViaFileInputAndOpen(options);
	}

	// nodine: gitignore-style skip list for the webkitdirectory fallback —
	// importing these (multi-GB node_modules) would hang the browser tab.
	private static readonly FOLDER_PICK_IGNORE = [
		'node_modules', '.git', '.next', '.turbo', '.cache', 'coverage',
		'dist', 'build', 'out', '.parcel-cache', '.venv', 'target',
	];

	/**
	 * nodine: bolt.diy-style folder pick for browsers without the File System
	 * Access API. Returns the tmp: root of the imported folder, or undefined
	 * when the user cancelled / nothing importable was found.
	 */
	private async pickFolderViaFileInput(): Promise<URI | undefined> {
		const activeWindow = this.getFilePickerWindow();
		const files = await new Promise<File[] | undefined>(resolve => {
			const input = activeWindow.document.createElement('input');
			input.type = 'file';
			input.multiple = true;
			(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
			input.style.display = 'none';
			let settled = false;
			const settle = (value: File[] | undefined): void => {
				if (settled) { return; }
				settled = true;
				resolve(value);
				input.remove();
			};
			input.addEventListener('change', () => {
				// change means files were chosen — wins over any cancel path
				settle(Array.from(input.files ?? []));
			});
			input.addEventListener('cancel', () => settle(undefined));
			// user cancelled without a change/cancel event (e.g. closed the
			// picker): detect via focus ONLY while the input is still live and
			// no files are present. Re-check for a grace period so a slow
			// change event (large folders) is not lost.
			const onFocusCheck = (): void => {
				setTimeout(() => {
					if (!settled && input.isConnected && (!input.files || input.files.length === 0)) {
						// one more grace period: change may still be in flight
						setTimeout(() => {
							if (!settled && input.isConnected && (!input.files || input.files.length === 0)) {
								settle(undefined);
							}
						}, 1500);
					}
				}, 500);
			};
			activeWindow.addEventListener('focus', onFocusCheck);
			const cleanup = (): void => activeWindow.removeEventListener('focus', onFocusCheck);
			input.addEventListener('change', cleanup, { once: true });
			activeWindow.document.body.appendChild(input);
			input.click();
		});
		if (!files || files.length === 0) { return undefined; }

		const relPath = (f: File): string => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
		const folderName = relPath(files[0]).split('/')[0] || 'opened-folder';
		const ignored = (rel: string): boolean =>
			FileDialogService.FOLDER_PICK_IGNORE.some(seg => rel.split('/').includes(seg));

		try {
			// virtual in-browser workspace for the imported folder
			const root = URI.from({ scheme: Schemas.tmp, path: `/${folderName}` });
			const ensureFolder = async (dir: URI): Promise<void> => {
				try { await this.fileService.createFolder(dir); } catch { /* exists */ }
			};
			await ensureFolder(root);

			let imported = 0;
			for (const file of files) {
				const rel = relPath(file).split('/').slice(1).join('/') || file.name;
				if (!rel || ignored(rel) || file.size > 512 * 1024) { continue; }
				const target = URI.joinPath(root, rel);
				await ensureFolder(dirname(target));
				await this.fileService.createFile(target, VSBuffer.wrap(new Uint8Array(await file.arrayBuffer())), { overwrite: true });
				imported++;
			}

			if (imported === 0) {
				this.dialogService.info(localize('openFolderViaInputEmpty', "No files imported from \"{0}\" — everything was filtered out (node_modules and build artifacts are skipped).", folderName));
				return undefined;
			}
			return root;
		} catch (error) {
			this.dialogService.error(localize('openFolderViaInputFailed', "Failed to open folder: {0}", getErrorMessage(error)));
			return undefined;
		}
	}

	private async pickFolderViaFileInputAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const root = await this.pickFolderViaFileInput();
		if (!root) { return; }

		// Swap the imported folder into the CURRENT window's workspace (no
		// reload: the in-memory tmp: files would not survive one).
		const workspaceEditingService: IWorkspaceEditingService = this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceEditingService));
		const current = this.contextService.getWorkspace().folders;
		await workspaceEditingService.updateFolders(0, current.length, [{ uri: root }], { force: true });
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void> {
		options.availableFileSystems = this.getWorkspaceAvailableFileSystems(options);
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultWorkspacePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickWorkspaceAndOpenSimplified(schema, options);
		}

		throw new Error(localize('pickWorkspaceAndOpen', "Can't open workspaces, try adding a folder to the workspace instead."));
	}

	async pickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		const schema = this.getFileSystemSchema({ defaultUri, availableFileSystems });

		const options = this.getPickFileToSaveDialogOptions(defaultUri, availableFileSystems);
		if (this.shouldUseSimplified(schema)) {
			return super.pickFileToSaveSimplified(schema, options);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('save');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		const startIn = Iterable.first(this.fileSystemProvider.directories);

		try {
			fileHandle = await activeWindow.showSaveFilePicker({ types: this.getFilePickerTypes(options.filters), ...{ suggestedName: basename(defaultUri), startIn } });
		} catch (error) {
			return; // `showSaveFilePicker` will throw an error when the user cancels
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return undefined;
		}

		return this.fileSystemProvider.registerFileHandle(fileHandle);
	}

	private getFilePickerTypes(filters?: FileFilter[]): FilePickerAcceptType[] | undefined {
		return filters?.filter(filter => {
			return !((filter.extensions.length === 1) && ((filter.extensions[0] === '*') || filter.extensions[0] === ''));
		}).map((filter): FilePickerAcceptType => {
			const accept: Record<MIMEType, FileExtension[]> = {};
			const extensions = filter.extensions.filter(ext => (ext.indexOf('-') < 0) && (ext.indexOf('*') < 0) && (ext.indexOf('_') < 0));
			accept[(getMediaOrTextMime(`fileName.${filter.extensions[0]}`) ?? 'text/plain') as MIMEType] = extensions.map(ext => ext.startsWith('.') ? ext : `.${ext}`) as FileExtension[];
			return {
				description: filter.name,
				accept
			};
		});
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		const schema = this.getFileSystemSchema(options);

		if (this.shouldUseSimplified(schema)) {
			return super.showSaveDialogSimplified(schema, options);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('save');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		const startIn = Iterable.first(this.fileSystemProvider.directories);

		try {
			fileHandle = await activeWindow.showSaveFilePicker({ types: this.getFilePickerTypes(options.filters), ...options.defaultUri ? { suggestedName: basename(options.defaultUri) } : undefined, ...{ startIn } });
		} catch (error) {
			return undefined; // `showSaveFilePicker` will throw an error when the user cancels
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return undefined;
		}

		return this.fileSystemProvider.registerFileHandle(fileHandle);
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		const schema = this.getFileSystemSchema(options);

		if (this.shouldUseSimplified(schema)) {
			return super.showOpenDialogSimplified(schema, options);
		}

		const activeWindow = this.getFilePickerWindow();

		// nodine: folder selection without the File System Access API (Brave
		// strict shields / Firefox / Safari) — webkitdirectory input, files
		// land in an in-browser tmp: folder, node_modules is never imported.
		if (!options.canSelectFiles && options.canSelectFolders && !WebFileSystemAccess.supported(activeWindow)) {
			const root = await this.pickFolderViaFileInput();
			return root ? [root] : undefined;
		}

		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('open');
		}

		const uris: URI[] = [];
		const startIn = await this.getFilePickerStartIn(options.defaultUri) ?? 'documents';

		try {
			if (options.canSelectFiles) {
				const handles = await activeWindow.showOpenFilePicker({ multiple: options.canSelectMany ?? false, types: this.getFilePickerTypes(options.filters), ...{ startIn } });
				for (const handle of handles) {
					if (WebFileSystemAccess.isFileSystemFileHandle(handle)) {
						uris.push(await this.fileSystemProvider.registerFileHandle(handle));
					}
				}
			} else {
				const handle = await activeWindow.showDirectoryPicker({ ...{ startIn } });
				uris.push(await this.fileSystemProvider.registerDirectoryHandle(handle));
			}
		} catch (error) {
			// ignore - `showOpenFilePicker` / `showDirectoryPicker` will throw an error when the user cancels
		}

		return uris.length ? uris : undefined;
	}

	protected getFilePickerWindow(): Window & typeof globalThis {
		return getActiveWindow();
	}

	private async getFilePickerStartIn(defaultUri: URI | undefined): Promise<FileSystemDirectoryHandle | undefined> {
		if (defaultUri) {
			try {
				const handle = await this.fileSystemProvider.getDirectoryHandle(defaultUri);
				if (handle) {
					return handle;
				}
			} catch (error) {
				this.logService.debug(`[FileDialogService] Failed to resolve default URI to a directory handle: ${getErrorMessage(error)}`);
			}
		}

		return Iterable.first(this.fileSystemProvider.directories);
	}

	private async showUnsupportedBrowserWarning(context: 'save' | 'open'): Promise<undefined> {

		// When saving, try to just download the contents
		// of the active text editor if any as a workaround
		if (context === 'save') {
			const activeCodeEditor = this.codeEditorService.getActiveCodeEditor();
			if (!(activeCodeEditor instanceof EmbeddedCodeEditorWidget)) {
				const activeTextModel = activeCodeEditor?.getModel();
				if (activeTextModel) {
					triggerDownload(VSBuffer.fromString(activeTextModel.getValue()).buffer, basename(activeTextModel.uri));
					return;
				}
			}
		}

		// Otherwise inform the user about options

		const buttons: IPromptButton<void>[] = [
			{
				label: localize({ key: 'openRemote', comment: ['&& denotes a mnemonic'] }, "&&Open Remote..."),
				run: async () => { await this.commandService.executeCommand('workbench.action.remote.showMenu'); }
			},
			{
				label: localize({ key: 'learnMore', comment: ['&& denotes a mnemonic'] }, "&&Learn More"),
				run: async () => { await this.openerService.open('https://aka.ms/VSCodeWebLocalFileSystemAccess'); }
			}
		];
		if (context === 'open') {
			buttons.push({
				label: localize({ key: 'openFiles', comment: ['&& denotes a mnemonic'] }, "Open &&Files..."),
				run: async () => {
					const files = await triggerUpload();
					if (files) {
						const filesData = (await this.instantiationService.invokeFunction(accessor => extractFileListData(accessor, files))).filter(fileData => !fileData.isDirectory);
						if (filesData.length > 0) {
							this.editorService.openEditors(filesData.map(fileData => {
								return {
									resource: fileData.resource,
									contents: fileData.contents?.toString(),
									options: { pinned: true }
								};
							}));
						}
					}
				}
			});
		}

		await this.dialogService.prompt({
			type: Severity.Warning,
			message: localize('unsupportedBrowserMessage', "Opening Local Folders is Unsupported"),
			detail: localize('unsupportedBrowserDetail', "Your browser doesn't support opening local folders.\nYou can either open single files or open a remote repository."),
			buttons
		});

		return undefined;
	}

	private shouldUseSimplified(scheme: string): boolean {
		return ![Schemas.file, Schemas.vscodeUserData, Schemas.tmp].includes(scheme);
	}
}

registerSingleton(IFileDialogService, FileDialogService, InstantiationType.Delayed);
