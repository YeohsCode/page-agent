/**
 * @page-agent/workflow
 *
 * Workflow recording and replay for PageAgent.
 * Save LLM-generated automation steps and replay them without LLM calls.
 */
export type {
	ElementSelector,
	StepPlayResult,
	Workflow,
	WorkflowPlayResult,
	WorkflowPlayerEvent,
	WorkflowStep,
} from './types'

export { extractSelector, findElement } from './elementMatcher'
export { fromHistory } from './WorkflowRecorder'
export { WorkflowPlayer } from './WorkflowPlayer'
export { WorkflowStore } from './WorkflowStore'
