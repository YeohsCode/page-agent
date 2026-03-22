/**
 * Workflow types for PageAgent step recording and replay.
 *
 * A Workflow captures a sequence of browser automation steps
 * that can be replayed without LLM calls.
 */

/**
 * A saved workflow containing all steps for replay
 */
export interface Workflow {
	/** Unique identifier */
	id: string
	/** User-facing name, e.g. "Login Flow" */
	name: string
	/** Optional description */
	description?: string
	/** ISO timestamp when first created */
	createdAt: string
	/** ISO timestamp when last updated */
	updatedAt: string
	/** URL where the workflow was recorded */
	sourceUrl: string
	/** Version number, incremented on each update */
	version: number
	/** Original task description given to the LLM */
	originalTask: string
	/** Ordered list of steps */
	steps: WorkflowStep[]
}

/**
 * A single recorded step in a workflow
 */
export interface WorkflowStep {
	/** Step index (0-based) */
	index: number
	/** Tool name: click_element_by_index, input_text, scroll, etc. */
	action: string
	/** Tool parameters (e.g. { index: 5 } or { index: 3, text: "hello" }) */
	params: Record<string, unknown>
	/** Element selector for relocating the target element on replay */
	selector: ElementSelector
	/** Human-readable description (from LLM's next_goal or reflection) */
	description: string
	/** Seconds to wait after this step (default: 0.5) */
	waitAfter: number
}

/**
 * Multi-strategy element selector.
 * Replay uses these properties to re-locate DOM elements
 * even when element indices change between sessions.
 */
export interface ElementSelector {
	/** CSS selector path (most precise) */
	cssSelector?: string
	/** Element text content */
	textContent?: string
	/** aria-label attribute */
	ariaLabel?: string
	/** HTML tag name (e.g. "button", "input") */
	tagName?: string
	/** Key HTML attributes for matching (id, name, placeholder, type, role, etc.) */
	attributes?: Record<string, string>
}

/**
 * Result of playing back a single step
 */
export interface StepPlayResult {
	stepIndex: number
	success: boolean
	message: string
	/** Milliseconds this step took */
	duration: number
}

/**
 * Result of playing back an entire workflow
 */
export interface WorkflowPlayResult {
	success: boolean
	/** Number of steps completed successfully */
	completedSteps: number
	/** Total steps in the workflow */
	totalSteps: number
	/** Results for each step attempted */
	stepResults: StepPlayResult[]
	/** Error message if the workflow failed */
	error?: string
}

/**
 * Events emitted by WorkflowPlayer
 */
export type WorkflowPlayerEvent =
	| { type: 'stepstart'; stepIndex: number; step: WorkflowStep }
	| { type: 'stepcomplete'; stepIndex: number; result: StepPlayResult }
	| { type: 'stepfailed'; stepIndex: number; result: StepPlayResult }
	| { type: 'complete'; result: WorkflowPlayResult }
	| { type: 'error'; message: string }
