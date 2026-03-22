/**
 * WorkflowStore - persistence and import/export for Workflows.
 *
 * Stores workflows in localStorage and supports JSON import/export.
 */
import type { Workflow } from './types'

const STORAGE_KEY = 'page-agent-workflows'

/**
 * Manage workflow persistence in localStorage.
 *
 * Usage:
 * ```typescript
 * const store = new WorkflowStore()
 * store.save(workflow)
 * const all = store.list()
 * store.delete(workflow.id)
 * ```
 */
export class WorkflowStore {
	/**
	 * Save a workflow. Creates or updates based on id.
	 */
	save(workflow: Workflow): void {
		const workflows = this.loadAll()
		const existingIndex = workflows.findIndex((w) => w.id === workflow.id)

		if (existingIndex >= 0) {
			workflow.updatedAt = new Date().toISOString()
			workflows[existingIndex] = workflow
		} else {
			workflows.push(workflow)
		}

		this.saveAll(workflows)
	}

	/**
	 * List all saved workflows, newest first.
	 */
	list(): Workflow[] {
		return this.loadAll().sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		)
	}

	/**
	 * Get a workflow by id.
	 */
	get(id: string): Workflow | null {
		return this.loadAll().find((w) => w.id === id) ?? null
	}

	/**
	 * Delete a workflow by id.
	 */
	delete(id: string): void {
		const workflows = this.loadAll().filter((w) => w.id !== id)
		this.saveAll(workflows)
	}

	/**
	 * Delete all workflows.
	 */
	clear(): void {
		this.saveAll([])
	}

	/**
	 * Export a workflow as a JSON string.
	 */
	exportToJSON(workflow: Workflow): string {
		return JSON.stringify(workflow, null, 2)
	}

	/**
	 * Import a workflow from a JSON string.
	 * @throws if JSON is invalid or missing required fields
	 */
	importFromJSON(json: string): Workflow {
		const parsed = JSON.parse(json) as Workflow

		// Validate required fields
		if (!parsed.id || !parsed.name || !Array.isArray(parsed.steps)) {
			throw new Error('Invalid workflow JSON: missing required fields (id, name, steps)')
		}

		// Ensure each step has required fields
		for (const step of parsed.steps) {
			if (step.action === undefined || step.index === undefined) {
				throw new Error(`Invalid workflow step at index ${step.index}: missing action or index`)
			}
		}

		return parsed
	}

	/**
	 * Trigger a file download of the workflow as JSON.
	 * Works in browser environments only.
	 */
	downloadAsFile(workflow: Workflow): void {
		const json = this.exportToJSON(workflow)
		const blob = new Blob([json], { type: 'application/json' })
		const url = URL.createObjectURL(blob)

		const a = document.createElement('a')
		a.href = url
		a.download = `workflow-${workflow.name.replace(/\s+/g, '-')}-${workflow.id}.json`
		document.body.appendChild(a)
		a.click()

		// Cleanup
		setTimeout(() => {
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
		}, 0)
	}

	/**
	 * Import a workflow from a File object (from file input).
	 */
	async importFromFile(file: File): Promise<Workflow> {
		const text = await file.text()
		return this.importFromJSON(text)
	}

	// ===== Private helpers =====

	private loadAll(): Workflow[] {
		try {
			const raw = localStorage.getItem(STORAGE_KEY)
			if (!raw) return []
			return JSON.parse(raw) as Workflow[]
		} catch {
			return []
		}
	}

	private saveAll(workflows: Workflow[]): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows))
	}
}
