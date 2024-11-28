import {
	equalityTest,
	getWorkflowFilenames,
	initBinaryDataService,
	setup,
	workflowToTests,
} from '@test/nodes/Helpers';
import nock from 'nock';

describe('GraphQL Node', () => {
	const workflows = getWorkflowFilenames(__dirname);
	const workflowTests = workflowToTests(workflows);

	beforeAll(async () => {
		await initBinaryDataService();
		nock.disableNetConnect();
	});

	afterAll(() => {
		nock.restore();
	});

	const nodeTypes = setup(workflowTests);

	for (const workflow of workflowTests) {
		test(workflow.description, async () => await equalityTest(workflow, nodeTypes));
	}
});
