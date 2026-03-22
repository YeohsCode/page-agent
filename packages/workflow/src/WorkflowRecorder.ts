/**
 * WorkflowRecorder - converts Agent execution history into a replayable Workflow.
 *
 * After the LLM-powered Agent completes a task, call `fromHistory()` to extract
 * the action steps and element selectors into a Workflow that can be replayed
 * without LLM.
 */
import { extractSelector } from './elementMatcher'
import type { ElementSelector, Workflow, WorkflowStep } from './types'

/** Shape of a history step event from @page-agent/core */
interface AgentStepEvent {
	type: 'step'
	stepIndex: number
	reflection: {
		evaluation_previous_goal?: string
		memory?: string
		next_goal?: string
	}
	action: {
		name: string
		input: any
		output: string
	}
}

/** Any history event from @page-agent/core */
interface HistoricalEvent {
	type: string
	[key: string]: unknown
}

/** Lightweight interface for element lookup */
interface SelectorMapLike {
	get(index: number): { ref?: Element | null } | undefined
}

/** Actions that should be skipped (not meaningful for replay) */
const SKIP_ACTIONS = new Set(['done', 'wait', 'ask_user'])

/**
 * Generate a unique ID
 */
function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

/**
 * Convert Agent execution history into a Workflow.
 *
 * @param history - Agent's history array after task completion
 * @param name - User-facing name for this workflow
 * @param originalTask - The original task description given to the LLM
 * @param sourceUrl - URL where the task was executed
 * @param selectorMap - Optional element map for extracting element selectors
 * @returns A Workflow ready for storage and replay
 */
export function fromHistory(
	history: readonly any[],
	name: string,
	originalTask: string,
	sourceUrl: string,
	selectorMap?: SelectorMapLike
): Workflow {
	const steps: WorkflowStep[] = []
	let stepIndex = 0

	for (const event of history) {
		if (event.type !== 'step') continue

		const stepEvent = event as unknown as AgentStepEvent
		const { action, reflection } = stepEvent

		// Skip non-operational actions
		if (SKIP_ACTIONS.has(action.name)) continue

		// Extract element selector if we have the selectorMap and the action targets an element
		let selector: ElementSelector = {}
		const elementIndex = action.input?.index as number | undefined

		if (elementIndex !== undefined && selectorMap) {
			const node = selectorMap.get(elementIndex)
			if (node?.ref && node.ref instanceof HTMLElement) {
				selector = extractSelector(node.ref)
			}
		}

		// Build the workflow step
		const step: WorkflowStep = {
			index: stepIndex,
			action: action.name,
			params: { ...action.input },
			selector,
			description: reflection?.next_goal || `Execute ${action.name}`,
			waitAfter: action.name === 'scroll' || action.name === 'scroll_horizontally' ? 0.3 : 0.5,
		}

		steps.push(step)
		stepIndex++
	}

	const now = new Date().toISOString()

	return {
		id: generateId(),
		name,
		createdAt: now,
		updatedAt: now,
		sourceUrl,
		version: 1,
		originalTask,
		steps,
	}
}

/**
 * Extract element selector from a live DOM element.
 * Re-exported from elementMatcher for convenience.
 */
export { extractSelector }
