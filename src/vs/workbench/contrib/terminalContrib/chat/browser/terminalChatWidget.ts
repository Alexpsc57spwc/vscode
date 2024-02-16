/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, IFocusTracker, hide, show, trackFocus } from 'vs/base/browser/dom';
import { Event } from 'vs/base/common/event';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./media/terminalChatWidget';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { ILanguageService } from 'vs/editor/common/languages/language';
import { ITextModel } from 'vs/editor/common/model';
import { IModelService } from 'vs/editor/common/services/model';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { AccessibilityVerbositySettingId } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { IChatAccessibilityService } from 'vs/workbench/contrib/chat/browser/chat';
import { IChatProgress } from 'vs/workbench/contrib/chat/common/chatService';
import { InlineChatWidget } from 'vs/workbench/contrib/inlineChat/browser/inlineChatWidget';
import { ITerminalInstance } from 'vs/workbench/contrib/terminal/browser/terminal';
import { TerminalContextKeys } from 'vs/workbench/contrib/terminal/common/terminalContextKey';
import { MENU_TERMINAL_CHAT_INPUT, MENU_TERMINAL_CHAT_WIDGET, MENU_TERMINAL_CHAT_WIDGET_FEEDBACK, MENU_TERMINAL_CHAT_WIDGET_STATUS } from 'vs/workbench/contrib/terminalContrib/chat/browser/terminalChat';

export class TerminalChatWidget extends Disposable {

	private readonly _container: HTMLElement;

	private readonly _inlineChatWidget: InlineChatWidget;
	public get inlineChatWidget(): InlineChatWidget { return this._inlineChatWidget; }

	private _responseEditor: TerminalChatResponseEditor | undefined;

	private readonly _focusTracker: IFocusTracker;

	private readonly _focusedContextKey: IContextKey<boolean>;
	private readonly _visibleContextKey: IContextKey<boolean>;

	constructor(
		terminalElement: HTMLElement,
		private readonly _instance: ITerminalInstance,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IChatAccessibilityService private readonly _chatAccessibilityService: IChatAccessibilityService,
	) {
		super();

		this._focusedContextKey = TerminalContextKeys.chatFocused.bindTo(this._contextKeyService);
		this._visibleContextKey = TerminalContextKeys.chatVisible.bindTo(this._contextKeyService);

		this._container = document.createElement('div');
		this._container.classList.add('terminal-inline-chat');
		terminalElement.appendChild(this._container);

		// The inline chat widget requires a parent editor that it bases the diff view on, since the
		// terminal doesn't use that feature we can just pass in an unattached editor instance.
		const fakeParentEditorElement = document.createElement('div');
		const fakeParentEditor = this._instantiationService.createInstance(
			CodeEditorWidget,
			fakeParentEditorElement,
			{
				extraEditorClassName: 'ignore-panel-bg'
			},
			{ isSimpleWidget: true }
		);

		this._inlineChatWidget = this._instantiationService.createInstance(
			InlineChatWidget,
			fakeParentEditor,
			{
				menuId: MENU_TERMINAL_CHAT_INPUT,
				widgetMenuId: MENU_TERMINAL_CHAT_WIDGET,
				statusMenuId: MENU_TERMINAL_CHAT_WIDGET_STATUS,
				feedbackMenuId: MENU_TERMINAL_CHAT_WIDGET_FEEDBACK
			}
		);
		this._reset();
		this._container.appendChild(this._inlineChatWidget.domNode);

		this._focusTracker = this._register(trackFocus(this._container));
	}

	private _reset() {
		this._inlineChatWidget.placeholder = localize('default.placeholder', "Ask how to do something in the terminal");
		this._inlineChatWidget.updateInfo(localize('welcome.1', "AI-generated commands may be incorrect"));
	}

	async renderTerminalCommand(command: string, requestId: number, shellType?: string): Promise<void> {
		this._chatAccessibilityService.acceptResponse(command, requestId);
		this._responseEditor?.show();
		if (!this._responseEditor) {
			this._responseEditor = this._instantiationService.createInstance(TerminalChatResponseEditor, command, shellType, this._container, this._instance);
		}
		this._responseEditor.setValue(command);
	}

	renderMessage(message: string, accessibilityRequestId: number, requestId: string): void {
		this._responseEditor?.hide();
		this._inlineChatWidget.updateChatMessage({ message: new MarkdownString(message), requestId, providerId: 'terminal' });
		this._chatAccessibilityService.acceptResponse(message, accessibilityRequestId);
	}

	reveal(): void {
		this._inlineChatWidget.layout(new Dimension(640, 150));
		this._container.classList.remove('hide');
		this._focusedContextKey.set(true);
		this._visibleContextKey.set(true);
		this._inlineChatWidget.focus();
	}
	hide(): void {
		this._container.classList.add('hide');
		this._reset();
		this._responseEditor?.dispose();
		this._responseEditor = undefined;
		this._inlineChatWidget.updateChatMessage(undefined);
		this._inlineChatWidget.updateFollowUps(undefined);
		this._inlineChatWidget.updateProgress(false);
		this._inlineChatWidget.updateToolbar(false);
		this._focusedContextKey.set(false);
		this._visibleContextKey.set(false);
		this._instance.focus();
	}
	focus(): void {
		this._inlineChatWidget.focus();
	}
	hasFocus(): boolean {
		return this._inlineChatWidget.hasFocus();
	}
	input(): string {
		return this._inlineChatWidget.value;
	}
	setValue(value?: string) {
		this._inlineChatWidget.value = value ?? '';
		if (!value) {
			this._responseEditor?.hide();
		}
	}
	acceptCommand(shouldExecute: boolean): void {
		// Trim command to remove any whitespace, otherwise this may execute the command
		const value = this._responseEditor?.getValue().trim();
		if (!value) {
			return;
		}
		this._instance.runCommand(value, shouldExecute);
		this.hide();
	}
	updateProgress(progress?: IChatProgress): void {
		this._inlineChatWidget.updateProgress(progress?.kind === 'content' || progress?.kind === 'markdownContent');
	}
	public get focusTracker(): IFocusTracker {
		return this._focusTracker;
	}
}

class TerminalChatResponseEditor extends Disposable {
	private readonly _editorContainer: HTMLElement;
	private readonly _editor: CodeEditorWidget;

	private readonly _responseEditorFocusedContextKey: IContextKey<boolean>;

	readonly model: Promise<ITextModel | null>;

	constructor(
		initialCommandResponse: string,
		shellType: string | undefined,
		private readonly _container: HTMLElement,
		private readonly _instance: ITerminalInstance,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IModelService private readonly _modelService: IModelService,
	) {
		super();

		this._responseEditorFocusedContextKey = TerminalContextKeys.chatResponseEditorFocused.bindTo(this._contextKeyService);

		this._editorContainer = document.createElement('div');
		this._editorContainer.classList.add('terminal-inline-chat-response');
		this._container.prepend(this._editorContainer);
		this._register(toDisposable(() => this._editorContainer.remove()));
		const editor = this._register(this._instantiationService.createInstance(CodeEditorWidget, this._editorContainer, {
			readOnly: false,
			ariaLabel: this._getAriaLabel(),
			fontSize: 13,
			lineHeight: 20,
			padding: { top: 8, bottom: 8 },
			overviewRulerLanes: 0,
			glyphMargin: false,
			lineNumbers: 'off',
			folding: false,
			hideCursorInOverviewRuler: true,
			selectOnLineNumbers: false,
			selectionHighlight: false,
			scrollbar: {
				useShadows: false,
				vertical: 'hidden',
				horizontal: 'hidden',
				alwaysConsumeMouseWheel: false
			},
			lineDecorationsWidth: 0,
			overviewRulerBorder: false,
			scrollBeyondLastLine: false,
			renderLineHighlight: 'none',
			fixedOverflowWidgets: true,
			dragAndDrop: false,
			revealHorizontalRightPadding: 5,
			minimap: { enabled: false },
			guides: { indentation: false },
			rulers: [],
			renderWhitespace: 'none',
			dropIntoEditor: { enabled: true },
			quickSuggestions: false,
			suggest: {
				showIcons: false,
				showSnippets: false,
				showWords: true,
				showStatusBar: false,
			},
			wordWrap: 'on'
		}, { isSimpleWidget: true }));
		this._editor = editor;
		this._register(editor.onDidFocusEditorText(() => this._responseEditorFocusedContextKey.set(true)));
		this._register(editor.onDidBlurEditorText(() => this._responseEditorFocusedContextKey.set(false)));
		this._register(Event.any(editor.onDidChangeModelContent, editor.onDidChangeModelDecorations)(() => {
			const height = editor.getContentHeight();
			editor.layout(new Dimension(640, height));
		}));

		this.model = this._getTextModel(URI.from({
			path: `terminal-inline-chat-${this._instance.instanceId}`,
			scheme: 'terminal-inline-chat',
			fragment: initialCommandResponse
		}));
		this.model.then(model => {
			if (model) {
				// Initial layout
				editor.layout(new Dimension(640, 0));
				editor.setModel(model);
				const height = editor.getContentHeight();
				editor.layout(new Dimension(640, height));

				// Initialize language
				const languageId = this._getLanguageFromShell(shellType);
				model.setLanguage(languageId);
			}
		});
	}

	private _getAriaLabel(): string {
		const verbose = this._configurationService.getValue<boolean>(AccessibilityVerbositySettingId.Chat);
		if (verbose) {
			// TODO: Add verbose description
		}
		return localize('terminalResponseEditor', "Terminal Response Editor");
	}

	private async _getTextModel(resource: URI): Promise<ITextModel | null> {
		const existing = this._modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		return this._modelService.createModel(resource.fragment, null, resource, false);
	}

	private _getLanguageFromShell(shell?: string): string {
		switch (shell) {
			case 'fish':
				return this._languageService.isRegisteredLanguageId('fish') ? 'fish' : 'shellscript';
			case 'zsh':
				return this._languageService.isRegisteredLanguageId('zsh') ? 'zsh' : 'shellscript';
			case 'bash':
				return this._languageService.isRegisteredLanguageId('bash') ? 'bash' : 'shellscript';
			case 'sh':
				return 'shellscript';
			case 'pwsh':
				return 'powershell';
			default:
				return 'plaintext';
		}
	}

	setValue(value: string) {
		this._editor.setValue(value);
	}

	getValue(): string {
		return this._editor.getValue();
	}

	hide() {
		hide(this._editorContainer);
	}

	show() {
		show(this._editorContainer);
	}
}