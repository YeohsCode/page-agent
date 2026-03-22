/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import { PageController, type PageControllerConfig } from '@page-agent/page-controller'
import { Panel } from '@page-agent/ui'
import { WorkflowPlayer, WorkflowStore, fromHistory } from '@page-agent/workflow'

export * from '@page-agent/core'

export type PageAgentConfig = AgentConfig & PageControllerConfig

export class PageAgent extends PageAgentCore {
	panel: Panel
	#workflowStore: WorkflowStore
	#workflowPlayer: WorkflowPlayer | null = null
	#pageController: PageController

	// Workflow callbacks (set by #setupWorkflowCallbacks, read by Panel via PanelAgentAdapter)
	onSaveWorkflow?: (name: string) => string | null
	onListWorkflows?: () => { id: string; name: string; steps: number; updatedAt: string }[]
	onPlayWorkflow?: (id: string) => Promise<{ success: boolean; message: string }>
	onStopWorkflow?: () => void
	onDeleteWorkflow?: (id: string) => void
	onExportWorkflow?: (id: string) => void
	onImportWorkflow?: (file: File) => Promise<string | null>
	onUpdateWorkflow?: (id: string) => Promise<void>

	constructor(config: PageAgentConfig) {
		const pageController = new PageController({
			...config,
			enableMask: config.enableMask ?? true,
		})

		super({ ...config, pageController })

		this.#pageController = pageController
		this.#workflowStore = new WorkflowStore()

		this.panel = new Panel(this, {
			language: config.language,
		})

		// Wire up workflow callbacks
		this.#setupWorkflowCallbacks()
	}

	#setupWorkflowCallbacks(): void {
		// Save current history as workflow
		this.onSaveWorkflow = (name: string): string | null => {
			try {
				const workflow = fromHistory(this.history, name, this.task || '', window.location.href)
				this.#workflowStore.save(workflow)
				return workflow.id
			} catch (e) {
				console.error('[PageAgent] Failed to save workflow:', e)
				return null
			}
		}

		// List all saved workflows
		this.onListWorkflows = () => {
			return this.#workflowStore.list().map((w) => ({
				id: w.id,
				name: w.name,
				steps: w.steps.length,
				updatedAt: w.updatedAt,
			}))
		}

		// Play a saved workflow (no LLM)
		this.onPlayWorkflow = async (id: string) => {
			const workflow = this.#workflowStore.get(id)
			if (!workflow) {
				return { success: false, message: 'Workflow not found' }
			}

			this.#workflowPlayer = new WorkflowPlayer(this.#pageController)
			try {
				const result = await this.#workflowPlayer.play(workflow)
				return {
					success: result.success,
					message: result.success
						? `✅ ${result.completedSteps}/${result.totalSteps} steps completed`
						: result.error || 'Workflow failed',
				}
			} finally {
				this.#workflowPlayer = null
			}
		}

		// Stop currently playing workflow
		this.onStopWorkflow = () => {
			this.#workflowPlayer?.stop()
		}

		// Delete a workflow
		this.onDeleteWorkflow = (id: string) => {
			this.#workflowStore.delete(id)
		}

		// Export workflow as JSON file
		this.onExportWorkflow = (id: string) => {
			const workflow = this.#workflowStore.get(id)
			if (workflow) {
				this.#workflowStore.downloadAsFile(workflow)
			}
		}

		// Import workflow from file
		this.onImportWorkflow = async (file: File): Promise<string | null> => {
			try {
				const workflow = await this.#workflowStore.importFromFile(file)
				this.#workflowStore.save(workflow)
				return workflow.id
			} catch (e) {
				console.error('[PageAgent] Failed to import workflow:', e)
				return null
			}
		}

		// Re-generate workflow by running the original task again
		this.onUpdateWorkflow = async (id: string) => {
			const oldWorkflow = this.#workflowStore.get(id)
			if (!oldWorkflow) return

			// Execute the original task again with LLM
			const result = await this.execute(oldWorkflow.originalTask)
			const execResult = result as { success?: boolean; history?: unknown[] }

			if (execResult?.success && this.history.length > 0) {
				const newWorkflow = fromHistory(
					this.history,
					oldWorkflow.name,
					oldWorkflow.originalTask,
					window.location.href
				)
				// Keep same ID, bump version
				newWorkflow.id = oldWorkflow.id
				newWorkflow.version = oldWorkflow.version + 1
				this.#workflowStore.save(newWorkflow)
			}
		}
	}
}
