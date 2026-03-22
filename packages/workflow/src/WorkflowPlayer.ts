/**
 * WorkflowPlayer - replays a saved Workflow without LLM calls.
 *
 * Executes workflow steps sequentially using PageController,
 * re-locating elements via ElementSelector instead of relying on
 * stale element indices.
 */
import type { PageController } from '@page-agent/page-controller'

import { findElement } from './elementMatcher'
import type {
	StepPlayResult,
	Workflow,
	WorkflowPlayResult,
	WorkflowPlayerEvent,
	WorkflowStep,
} from './types'

/**
 * Wait helper
 */
function waitFor(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/**
 * Replays a Workflow step-by-step without LLM.
 *
 * Usage:
 * ```typescript
 * const player = new WorkflowPlayer(pageController)
 * player.addEventListener('stepcomplete', (e) => console.log(e.detail))
 * const result = await player.play(workflow)
 * ```
 *
 * Emits events: stepstart, stepcomplete, stepfailed, complete, error
 */
export class WorkflowPlayer extends EventTarget {
	private pageController: PageController
	private abortController: AbortController | null = null
	private _isPlaying = false

	constructor(pageController: PageController) {
		super()
		this.pageController = pageController
	}

	/** Whether a workflow is currently playing */
	get isPlaying(): boolean {
		return this._isPlaying
	}

	/**
	 * Play a workflow from start to finish.
	 * @param workflow - The workflow to play
	 * @returns Result summary
	 */
	async play(workflow: Workflow): Promise<WorkflowPlayResult> {
		if (this._isPlaying) {
			throw new Error('A workflow is already playing. Call stop() first.')
		}

		this._isPlaying = true
		this.abortController = new AbortController()

		const stepResults: StepPlayResult[] = []
		let completedSteps = 0

		try {
			// Show mask during replay
			await this.pageController.showMask()

			for (const step of workflow.steps) {
				// Check abort
				if (this.abortController.signal.aborted) {
					break
				}

				// Emit stepstart
				this.emit({ type: 'stepstart', stepIndex: step.index, step })

				const startTime = Date.now()
				const result = await this.executeStep(step)
				result.duration = Date.now() - startTime

				stepResults.push(result)

				if (result.success) {
					completedSteps++
					this.emit({ type: 'stepcomplete', stepIndex: step.index, result })
				} else {
					this.emit({ type: 'stepfailed', stepIndex: step.index, result })
					// Stop on first failure
					break
				}

				// Wait between steps
				if (step.waitAfter > 0 && !this.abortController.signal.aborted) {
					await waitFor(step.waitAfter)
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.emit({ type: 'error', message })
		} finally {
			await this.pageController.hideMask()
			this.pageController.cleanUpHighlights()
			this._isPlaying = false
			this.abortController = null
		}

		const lastResult = stepResults[stepResults.length - 1]
		const aborted = completedSteps < workflow.steps.length && (!lastResult || lastResult.success)

		const playResult: WorkflowPlayResult = {
			success: completedSteps === workflow.steps.length,
			completedSteps,
			totalSteps: workflow.steps.length,
			stepResults,
			error: aborted
				? 'Workflow was stopped by user'
				: completedSteps < workflow.steps.length
					? `Failed at step ${completedSteps}: ${stepResults[stepResults.length - 1]?.message}`
					: undefined,
		}

		this.emit({ type: 'complete', result: playResult })
		return playResult
	}

	/**
	 * Stop the currently playing workflow.
	 */
	stop(): void {
		this.abortController?.abort()
	}

	/**
	 * Execute a single workflow step.
	 */
	private async executeStep(step: WorkflowStep): Promise<StepPlayResult> {
		try {
			// Refresh DOM tree for element lookup
			await this.pageController.updateTree()

			// Actions that don't need element lookup
			if (step.action === 'scroll') {
				const result = await this.pageController.scroll({
					down: (step.params.down as boolean) ?? true,
					numPages: (step.params.num_pages as number) ?? 0.1,
					pixels: step.params.pixels as number | undefined,
				})
				return {
					stepIndex: step.index,
					success: result.success,
					message: result.message,
					duration: 0,
				}
			}

			if (step.action === 'scroll_horizontally') {
				const result = await this.pageController.scrollHorizontally({
					right: (step.params.right as boolean) ?? true,
					pixels: (step.params.pixels as number) ?? 100,
				})
				return {
					stepIndex: step.index,
					success: result.success,
					message: result.message,
					duration: 0,
				}
			}

			// For element-targeted actions, find the element using selector
			const element = findElement(step.selector)

			if (!element) {
				return {
					stepIndex: step.index,
					success: false,
					message:
						`❌ Cannot locate element for step "${step.description}". ` +
						`Selector: ${JSON.stringify(step.selector)}. ` +
						`The page structure may have changed. Try "Update" to re-record.`,
					duration: 0,
				}
			}

			// Find element index in the current selector map by matching DOM reference
			const elementIndex = await this.findElementIndexInMap(element)

			if (elementIndex === null) {
				return {
					stepIndex: step.index,
					success: false,
					message:
						`❌ Element found but not in interactive elements. ` +
						`The element may not be interactive or visible.`,
					duration: 0,
				}
			}

			// Execute the action using PageController
			let result: { success: boolean; message: string }

			switch (step.action) {
				case 'click_element_by_index':
					result = await this.pageController.clickElement(elementIndex)
					break

				case 'input_text':
					result = await this.pageController.inputText(elementIndex, step.params.text as string)
					break

				case 'select_dropdown_option':
					result = await this.pageController.selectOption(elementIndex, step.params.text as string)
					break

				default:
					return {
						stepIndex: step.index,
						success: false,
						message: `❌ Unknown action: ${step.action}`,
						duration: 0,
					}
			}

			return {
				stepIndex: step.index,
				success: result.success,
				message: result.message,
				duration: 0,
			}
		} catch (error) {
			return {
				stepIndex: step.index,
				success: false,
				message: `❌ Step execution error: ${error instanceof Error ? error.message : String(error)}`,
				duration: 0,
			}
		}
	}

	/**
	 * Find the current index of a DOM element in PageController's selector map.
	 * Since selector map is private, we use updateTree() to refresh it, then
	 * look for the element among interactive elements by doing a fresh click.
	 *
	 * Workaround: We iterate the simplified HTML to match element text against
	 * the target element's text content.
	 */
	private async findElementIndexInMap(target: HTMLElement): Promise<number | null> {
		// Get the current simplified HTML from the controller
		const html = await this.pageController.updateTree()

		// Parse the indexed elements: [INDEX]<tag>text</tag>
		const indexPattern = /\[(\d+)\]/g
		let match: RegExpExecArray | null
		const indices: number[] = []

		while ((match = indexPattern.exec(html)) !== null) {
			indices.push(parseInt(match[1], 10))
		}

		// Try each index - use clickElement to test if the element matches
		// This is a brute force approach; in future, PageController should expose
		// a method for selector-based index lookup.
		for (const index of indices) {
			try {
				// We need a way to check if an index points to our target element.
				// Since PageController doesn't expose the selectorMap publicly,
				// we check by seeing if the page controller's indexed element
				// matches our target by comparing DOM nodes.

				// For now, attempt to match using the simplified HTML text
				// This is a reasonable heuristic that works in most cases.
				const targetText = target.textContent?.trim() || ''
				const targetTag = target.tagName.toLowerCase()

				// Find the line in HTML that contains this index
				const linePattern = new RegExp(
					`\\[${index}\\]<${targetTag}[^>]*>([^<]*)</${targetTag}>|\\[${index}\\]<${targetTag}[^/]*/>`,
					'i'
				)
				const lineMatch = linePattern.exec(html)
				if (lineMatch) {
					const elementText = (lineMatch[1] || '').trim()
					if (targetText && elementText === targetText) {
						return index
					}
					// Check attributes match
					const targetId = target.id
					if (targetId && lineMatch[0].includes(`id="${targetId}"`)) {
						return index
					}
					const targetPlaceholder = target.getAttribute('placeholder')
					if (targetPlaceholder && lineMatch[0].includes(targetPlaceholder)) {
						return index
					}
				}
			} catch {
				// Continue to next index
			}
		}

		// Fallback: match by position heuristic
		// If we found the element via CSS but can't map to an index,
		// try direct element property matching
		for (const index of indices) {
			// Build a pattern to extract element description from HTML
			const linePattern = new RegExp(`\\[${index}\\](.+?)(?:\\n|$)`)
			const lineMatch = linePattern.exec(html)
			if (!lineMatch) continue

			const line = lineMatch[1]
			// Check multiple matching criteria
			const matchScore = computeMatchScore(target, line)
			if (matchScore >= 3) {
				return index
			}
		}

		return null
	}

	/**
	 * Emit a typed event
	 */
	private emit(event: WorkflowPlayerEvent): void {
		this.dispatchEvent(new CustomEvent(event.type, { detail: event }))
	}
}

/**
 * Score how well an HTML description line matches a target element
 */
function computeMatchScore(element: HTMLElement, htmlLine: string): number {
	let score = 0
	const line = htmlLine.toLowerCase()
	const tag = element.tagName.toLowerCase()

	if (line.includes(`<${tag}`)) score += 1

	const text = element.textContent?.trim().toLowerCase() || ''
	if (text && text.length > 0 && text.length < 100 && line.includes(text)) score += 2

	const id = element.id
	if (id && line.includes(id)) score += 3

	const placeholder = element.getAttribute('placeholder')?.toLowerCase()
	if (placeholder && line.includes(placeholder)) score += 2

	const name = element.getAttribute('name')?.toLowerCase()
	if (name && line.includes(name)) score += 2

	const ariaLabel = element.getAttribute('aria-label')?.toLowerCase()
	if (ariaLabel && line.includes(ariaLabel)) score += 2

	return score
}
