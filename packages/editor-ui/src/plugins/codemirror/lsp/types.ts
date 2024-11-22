import type { CompletionResult } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import type ts from 'typescript';
import type { Schema } from '@/Interface';
import type { CodeExecutionMode } from 'n8n-workflow';

export interface HoverInfo {
	start: number;
	end: number;
	typeDef?: readonly ts.DefinitionInfo[];
	quickInfo: ts.QuickInfo | undefined;
}

export type LanguageServiceWorker = {
	init(
		content: string,
		nodeJsonFetcher: (nodeName: string) => Promise<Schema | undefined>,
		allNodeNames: string[],
		inputNodeNames: string[],
		mode: CodeExecutionMode,
	): Promise<void>;
	updateFile(content: string): void;
	updateMode(mode: CodeExecutionMode): void;
	getCompletionsAtPos(pos: number): Promise<CompletionResult | null>;
	getDiagnostics(): Diagnostic[];
	getHoverTooltip(pos: number): HoverInfo | null;
};
