import type express from 'express';
import { Service } from 'typedi';

import {
	type IWebhookData,
	type IWorkflowExecuteAdditionalData,
	type IHttpRequestMethods,
	type Workflow,
	type WorkflowActivateMode,
	type WorkflowExecuteMode,
	ApplicationError,
	type IRunData,
} from 'n8n-workflow';

import { ActiveWebhooks } from '@/ActiveWebhooks';
import type {
	IResponseCallbackData,
	IWebhookManager,
	IWorkflowDb,
	WebhookAccessControlOptions,
	WebhookRequest,
} from '@/Interfaces';
import { Push } from '@/push';
import { NodeTypes } from '@/NodeTypes';
import * as WebhookHelpers from '@/WebhookHelpers';
import { webhookNotFoundErrorMessage } from './utils';
import { NotFoundError } from './errors/response-errors/not-found.error';

const WEBHOOK_TEST_UNREGISTERED_HINT =
	"Click the 'Execute workflow' button on the canvas, then try again. (In test mode, the webhook only works for one call after you click this button)";

@Service()
export class TestWebhooks implements IWebhookManager {
	private testWebhookData: {
		[key: string]: {
			sessionId?: string;
			timeout: NodeJS.Timeout;
			workflowData: IWorkflowDb;
			workflow: Workflow;
			destinationNode?: string;
		};
	} = {};

	constructor(
		private readonly activeWebhooks: ActiveWebhooks,
		private readonly push: Push,
		private readonly nodeTypes: NodeTypes,
	) {
		activeWebhooks.testWebhooks = true;
	}

	/**
	 * Executes a test-webhook and returns the data. It also makes sure that the
	 * data gets additionally send to the UI. After the request got handled it
	 * automatically remove the test-webhook.
	 */
	async executeWebhook(
		request: WebhookRequest,
		response: express.Response,
	): Promise<IResponseCallbackData> {
		const httpMethod = request.method;
		let path = request.params.path;

		// Reset request parameters
		request.params = {} as WebhookRequest['params'];

		// Remove trailing slash
		if (path.endsWith('/')) {
			path = path.slice(0, -1);
		}

		const { activeWebhooks, push, testWebhookData } = this;

		let webhookData: IWebhookData | undefined = activeWebhooks.get(httpMethod, path);

		// check if path is dynamic
		if (webhookData === undefined) {
			const pathElements = path.split('/');
			const webhookId = pathElements.shift();

			webhookData = activeWebhooks.get(httpMethod, pathElements.join('/'), webhookId);
			if (webhookData === undefined) {
				// The requested webhook is not registered
				const methods = await this.getWebhookMethods(path);
				throw new NotFoundError(
					webhookNotFoundErrorMessage(path, httpMethod, methods),
					WEBHOOK_TEST_UNREGISTERED_HINT,
				);
			}

			path = webhookData.path;
			// extracting params from path
			path.split('/').forEach((ele, index) => {
				if (ele.startsWith(':')) {
					// write params to req.params
					// @ts-ignore
					request.params[ele.slice(1)] = pathElements[index];
				}
			});
		}

		const { workflowId } = webhookData;
		const webhookKey = `${activeWebhooks.getWebhookKey(
			webhookData.httpMethod,
			webhookData.path,
			webhookData.webhookId,
		)}|${workflowId}`;

		// TODO: Clean that duplication up one day and improve code generally
		if (testWebhookData[webhookKey] === undefined) {
			// The requested webhook is not registered
			const methods = await this.getWebhookMethods(path);
			throw new NotFoundError(
				webhookNotFoundErrorMessage(path, httpMethod, methods),
				WEBHOOK_TEST_UNREGISTERED_HINT,
			);
		}

		const { destinationNode, sessionId, workflow, workflowData, timeout } =
			testWebhookData[webhookKey];

		// Get the node which has the webhook defined to know where to start from and to
		// get additional data
		const workflowStartNode = workflow.getNode(webhookData.node);
		if (workflowStartNode === null) {
			throw new NotFoundError('Could not find node to process webhook.');
		}

		return new Promise(async (resolve, reject) => {
			try {
				const executionMode = 'manual';
				const executionId = await WebhookHelpers.executeWebhook(
					workflow,
					webhookData!,
					workflowData,
					workflowStartNode,
					executionMode,
					sessionId,
					undefined,
					undefined,
					request,
					response,
					(error: Error | null, data: IResponseCallbackData) => {
						if (error !== null) reject(error);
						else resolve(data);
					},
					destinationNode,
				);

				// The workflow did not run as the request was probably setup related
				// or a ping so do not resolve the promise and wait for the real webhook
				// request instead.
				if (executionId === undefined) return;

				// Inform editor-ui that webhook got received
				if (sessionId !== undefined) {
					push.send('testWebhookReceived', { workflowId, executionId }, sessionId);
				}
			} catch {}

			// Delete webhook also if an error is thrown
			if (timeout) clearTimeout(timeout);
			delete testWebhookData[webhookKey];

			await activeWebhooks.removeWorkflow(workflow);
		});
	}

	async getWebhookMethods(path: string): Promise<IHttpRequestMethods[]> {
		const webhookMethods = this.activeWebhooks.getWebhookMethods(path);
		if (!webhookMethods.length) {
			// The requested webhook is not registered
			throw new NotFoundError(webhookNotFoundErrorMessage(path), WEBHOOK_TEST_UNREGISTERED_HINT);
		}

		return webhookMethods;
	}

	async findAccessControlOptions(path: string, httpMethod: IHttpRequestMethods) {
		const webhookKey = Object.keys(this.testWebhookData).find(
			(key) => key.includes(path) && key.startsWith(httpMethod),
		);
		if (!webhookKey) return;

		const { workflow } = this.testWebhookData[webhookKey];
		const webhookNode = Object.values(workflow.nodes).find(
			({ type, parameters, typeVersion }) =>
				parameters?.path === path &&
				(parameters?.httpMethod ?? 'GET') === httpMethod &&
				'webhook' in this.nodeTypes.getByNameAndVersion(type, typeVersion),
		);
		return webhookNode?.parameters?.options as WebhookAccessControlOptions;
	}

	/**
	 * Checks if it has to wait for webhook data to execute the workflow.
	 * If yes it waits for it and resolves with the result of the workflow if not it simply resolves with undefined
	 */
	async needsWebhookData(
		workflowData: IWorkflowDb,
		workflow: Workflow,
		runData: IRunData,
		additionalData: IWorkflowExecuteAdditionalData,
		mode: WorkflowExecuteMode,
		activation: WorkflowActivateMode,
		sessionId?: string,
		destinationNode?: string,
	): Promise<boolean> {
		const webhooks = WebhookHelpers.getWorkflowWebhooks(
			workflow,
			additionalData,
			destinationNode,
			true,
		);
		if (!webhooks.find((webhook) => webhook.webhookDescription.restartWebhook !== true)) {
			// No webhooks found to start a workflow
			return false;
		}

		if (workflow.id === undefined) {
			throw new ApplicationError(
				'Webhooks can only be added for saved workflows as an ID is needed',
			);
		}

		// Remove test-webhooks automatically if they do not get called (after 120 seconds)
		const timeout = setTimeout(() => {
			this.cancelTestWebhook(workflowData.id);
		}, 120000);

		const { activeWebhooks, testWebhookData } = this;

		let key: string;
		const activatedKey: string[] = [];

		for (const webhookData of webhooks) {
			key = `${activeWebhooks.getWebhookKey(
				webhookData.httpMethod,
				webhookData.path,
				webhookData.webhookId,
			)}|${workflowData.id}`;

			if (runData && webhookData.node in runData) {
				return false;
			}

			activatedKey.push(key);

			testWebhookData[key] = {
				sessionId,
				timeout,
				workflow,
				workflowData,
				destinationNode,
			};

			try {
				await activeWebhooks.add(workflow, webhookData, mode, activation);
			} catch (error) {
				activatedKey.forEach((deleteKey) => delete testWebhookData[deleteKey]);

				await activeWebhooks.removeWorkflow(workflow);
				throw error;
			}
		}

		return true;
	}

	/**
	 * Removes a test webhook of the workflow with the given id
	 *
	 */
	cancelTestWebhook(workflowId: string): boolean {
		let foundWebhook = false;
		const { activeWebhooks, push, testWebhookData } = this;

		for (const webhookKey of Object.keys(testWebhookData)) {
			const { sessionId, timeout, workflow, workflowData } = testWebhookData[webhookKey];

			if (workflowData.id !== workflowId) {
				continue;
			}

			clearTimeout(timeout);

			// Inform editor-ui that webhook got received
			if (sessionId !== undefined) {
				try {
					push.send('testWebhookDeleted', { workflowId }, sessionId);
				} catch {
					// Could not inform editor, probably is not connected anymore. So simply go on.
				}
			}

			// Remove the webhook
			delete testWebhookData[webhookKey];

			if (!foundWebhook) {
				// As it removes all webhooks of the workflow execute only once
				void activeWebhooks.removeWorkflow(workflow);
			}

			foundWebhook = true;
		}

		return foundWebhook;
	}
}
