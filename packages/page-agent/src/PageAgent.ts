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
	onNavigate?: (url: string) => void

	constructor(config: PageAgentConfig) {
		// If in Tauri, merge injected config
		const tauriConfig = (window as any).PAGE_AGENT_CONFIG;
		const mergedConfig = {
			...config,
			...(tauriConfig || {})
		};

		const pageController = new PageController({
			...mergedConfig,
			enableMask: mergedConfig.enableMask ?? true,
		})

		super({ ...mergedConfig, pageController })

		this.#pageController = pageController
		this.#workflowStore = new WorkflowStore()

		this.panel = new Panel(this, {
			language: mergedConfig.language,
		})

		// Wire up workflow callbacks
		this.#setupWorkflowCallbacks()

		// Show panel immediately in desktop sessions
		this.panel.show()
	}

	#isTauri(): boolean {
		return !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
	}

	async #invokeTauri<T>(cmd: string, args?: any): Promise<T> {
		const tauri = (window as any).__TAURI__;
		if (tauri && tauri.core && tauri.core.invoke) {
			return tauri.core.invoke(cmd, args);
		}
		// Fallback for v2 with globals enabled or injected
		if ((window as any).__TAURI_INTERNALS__) {
			return (window as any).__TAURI_INTERNALS__.invoke(cmd, args);
		}
		throw new Error("Tauri not found");
	}

	#setupWorkflowCallbacks(): void {
		const isTauri = this.#isTauri();

		// Save current history as workflow
		this.onSaveWorkflow = (name: string): string | null => {
			try {
				const workflow = fromHistory(this.history, name, this.task || '', window.location.href)

				if (isTauri) {
					this.#invokeTauri("save_workflow", {
						id: workflow.id,
						workflowJson: JSON.stringify(workflow)
					}).catch(e => console.error("Tauri save failed", e));
				} else {
					this.#workflowStore.save(workflow)
				}
				return workflow.id
			} catch (e) {
				console.error('[PageAgent] Failed to save workflow:', e)
				return null
			}
		}

		// List all saved workflows
		this.onListWorkflows = () => {
			// Note: list is sync in Panel, so for Tauri we might need to pre-fetch 
			// or handle the sync/async gap. For now, use localStore as cache plus Rust as source.
			// Or better: Panel supports async list? No, it's sync.
			// Tactical fix: for Desktop, we'll rely on the Dashboard for listing/management,
			// but we want the on-page list to work too.
			return this.#workflowStore.list().map((w) => ({
				id: w.id,
				name: w.name,
				steps: w.steps.length,
				updatedAt: w.updatedAt,
			}))
		}

		// Play a saved workflow (no LLM)
		this.onPlayWorkflow = async (id: string) => {
			let workflow = this.#workflowStore.get(id)

			if (!workflow && isTauri) {
				// Try fetching from Rust if not in local cache
				try {
					const allWfs = await this.#invokeTauri<string[]>("list_workflows");
					const found = allWfs.find(s => s.includes(id));
					if (found) workflow = JSON.parse(found);
				} catch (e) {
					console.error("Tauri load failed", e);
				}
			}

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
			if (isTauri) {
				this.#invokeTauri("delete_workflow", { id }).catch(e => console.error("Tauri delete failed", e));
			}
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
				if (isTauri) {
					await this.#invokeTauri("save_workflow", {
						id: workflow.id,
						workflowJson: JSON.stringify(workflow)
					});
				} else {
					this.#workflowStore.save(workflow)
				}
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

				if (isTauri) {
					await this.#invokeTauri("save_workflow", {
						id: newWorkflow.id,
						workflowJson: JSON.stringify(newWorkflow)
					});
				} else {
					this.#workflowStore.save(newWorkflow)
				}
			}
		}

		// Support navigation within the window
		this.onNavigate = (url: string) => {
			if (!url) return
			let finalUrl = url.trim()
			if (!/^https?:\/\//i.test(finalUrl)) {
				finalUrl = 'https://' + finalUrl
			}
			window.location.href = finalUrl
		}
	}
}
