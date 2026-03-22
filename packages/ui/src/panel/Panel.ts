import { I18n, type SupportedLanguage } from '../i18n'
import { truncate } from '../utils'
import { createCard, createReflectionLines } from './cards'
import type { AgentActivity, PanelAgentAdapter } from './types'

import styles from './Panel.module.css'

/**
 * Panel configuration
 */
export interface PanelConfig {
	language?: SupportedLanguage
	/**
	 * Whether to prompt for next task after task completion
	 * @default true
	 */
	promptForNextTask?: boolean
}

/**
 * Agent control panel
 *
 * Architecture:
 * - History list: renders directly from agent.history (historical events)
 * - Header bar: shows activity events (transient state) and agent status
 *
 * This separation ensures data consistency - history is the single source of truth
 * for what has been done, while activity shows what is happening now.
 */
export class Panel {
	#wrapper: HTMLElement
	#indicator: HTMLElement
	#statusText: HTMLElement
	#historySection: HTMLElement
	#expandButton: HTMLElement
	#actionButton: HTMLElement
	#inputSection: HTMLElement
	#taskInput: HTMLInputElement

	#agent: PanelAgentAdapter
	#config: PanelConfig
	#isExpanded = false
	#i18n: I18n
	#userAnswerResolver: ((input: string) => void) | null = null
	#isWaitingForUserAnswer: boolean = false
	#headerUpdateTimer: ReturnType<typeof setInterval> | null = null
	#pendingHeaderText: string | null = null
	#isAnimating = false

	// Event handlers (bound for removal)
	#onStatusChange = () => this.#handleStatusChange()
	#onHistoryChange = () => this.#handleHistoryChange()
	#onActivity = (e: Event) => this.#handleActivity((e as CustomEvent<AgentActivity>).detail)
	#onAgentDispose = () => this.dispose()

	get wrapper(): HTMLElement {
		return this.#wrapper
	}

	/**
	 * Create a Panel bound to an agent
	 * @param agent - Agent instance that implements PanelAgentAdapter
	 * @param config - Optional panel configuration
	 */
	constructor(agent: PanelAgentAdapter, config: PanelConfig = {}) {
		this.#agent = agent
		this.#config = config
		this.#i18n = new I18n(config.language ?? 'en-US')

		// Set up askUser callback on agent
		this.#agent.onAskUser = (question) => this.#askUser(question)

		// Create UI elements
		this.#wrapper = this.#createWrapper()
		this.#indicator = this.#wrapper.querySelector(`.${styles.indicator}`)!
		this.#statusText = this.#wrapper.querySelector(`.${styles.statusText}`)!
		this.#historySection = this.#wrapper.querySelector(`.${styles.historySection}`)!
		this.#expandButton = this.#wrapper.querySelector(`.${styles.expandButton}`)!
		this.#actionButton = this.#wrapper.querySelector(`.${styles.stopButton}`)!
		this.#inputSection = this.#wrapper.querySelector(`.${styles.inputSectionWrapper}`)!
		this.#taskInput = this.#wrapper.querySelector(`.${styles.taskInput}`)!

		// Listen to agent events
		this.#agent.addEventListener('statuschange', this.#onStatusChange)
		this.#agent.addEventListener('historychange', this.#onHistoryChange)
		this.#agent.addEventListener('activity', this.#onActivity)
		this.#agent.addEventListener('dispose', this.#onAgentDispose)

		this.#setupEventListeners()
		this.#startHeaderUpdateLoop()

		this.#showInputArea()

		this.hide() // Start hidden
	}

	// ========== Agent event handlers ==========

	/** Handle agent status change */
	#handleStatusChange(): void {
		const status = this.#agent.status

		// Map agent status to UI indicator type
		const indicatorType =
			status === 'running' ? 'thinking' : status === 'idle' ? 'thinking' : status
		this.#updateStatusIndicator(indicatorType)

		// Morph action button: running = stop (■), not running = close (X)
		if (status === 'running') {
			this.#actionButton.textContent = '■'
			this.#actionButton.title = this.#i18n.t('ui.panel.stop')
		} else {
			this.#actionButton.textContent = 'X'
			this.#actionButton.title = this.#i18n.t('ui.panel.close')
		}

		// Show/hide based on status
		if (status === 'running') {
			this.show()
			this.#hideInputArea() // Hide input while running
		}

		// Handle completion
		if (status === 'completed' || status === 'error') {
			if (!this.#isExpanded) {
				this.#expand()
			}
			if (this.#shouldShowInputArea()) {
				this.#showInputArea()
			}
			// Show workflow buttons if agent supports it
			if (status === 'completed' && this.#agent.onSaveWorkflow) {
				this.#showWorkflowBar()
			}
		}
	}

	/** Handle agent history change - re-render history list from agent.history */
	#handleHistoryChange(): void {
		this.#renderHistory()
	}

	/**
	 * Handle agent activity - transient state for immediate UI feedback
	 * Activity events are NOT persisted in history, only used for header bar updates
	 */
	#handleActivity(activity: AgentActivity): void {
		switch (activity.type) {
			case 'thinking':
				this.#pendingHeaderText = this.#i18n.t('ui.panel.thinking')
				this.#updateStatusIndicator('thinking')
				break

			case 'executing':
				this.#pendingHeaderText = this.#getToolExecutingText(activity.tool, activity.input)
				this.#updateStatusIndicator('executing')
				break

			case 'executed':
				this.#pendingHeaderText = truncate(activity.output, 50)
				break

			case 'retrying':
				this.#pendingHeaderText = `Retrying (${activity.attempt}/${activity.maxAttempts})`
				this.#updateStatusIndicator('retrying')
				break

			case 'error':
				this.#pendingHeaderText = truncate(activity.message, 50)
				this.#updateStatusIndicator('error')
				break
		}
	}

	/**
	 * Ask for user input (internal, called by agent via onAskUser)
	 */
	#askUser(question: string): Promise<string> {
		return new Promise((resolve) => {
			// Set `waiting for user answer` state
			this.#isWaitingForUserAnswer = true
			this.#userAnswerResolver = resolve

			// Expand history panel
			if (!this.#isExpanded) {
				this.#expand()
			}

			// Add temporary question card so user can see the full question
			const tempCard = document.createElement('div')
			tempCard.innerHTML = createCard({
				icon: '❓',
				content: `Question: ${question}`,
				type: 'question',
			})
			const cardElement = tempCard.firstElementChild as HTMLElement
			cardElement.setAttribute('data-temp-card', 'true')
			this.#historySection.appendChild(cardElement)
			this.#scrollToBottom()

			this.#showInputArea(this.#i18n.t('ui.panel.userAnswerPrompt'))
		})
	}

	// ========== Public control methods ==========

	show(): void {
		this.wrapper.style.display = 'block'
		void this.wrapper.offsetHeight
		this.wrapper.style.opacity = '1'
		this.wrapper.style.transform = 'translateX(-50%) translateY(0)'
	}

	hide(): void {
		this.wrapper.style.opacity = '0'
		this.wrapper.style.transform = 'translateX(-50%) translateY(20px)'
		this.wrapper.style.display = 'none'
	}

	reset(): void {
		this.#statusText.textContent = this.#i18n.t('ui.panel.ready')
		this.#updateStatusIndicator('thinking')
		this.#renderHistory()
		this.#collapse()
		// Reset user input state
		this.#isWaitingForUserAnswer = false
		this.#userAnswerResolver = null
		// Hide workflow UI
		this.#hideWorkflowUI()
		// Show input area
		this.#showInputArea()
	}

	expand(): void {
		this.#expand()
	}

	collapse(): void {
		this.#collapse()
	}

	/**
	 * Dispose panel and clean up event listeners
	 */
	dispose(): void {
		// Remove agent event listeners
		this.#agent.removeEventListener('statuschange', this.#onStatusChange)
		this.#agent.removeEventListener('historychange', this.#onHistoryChange)
		this.#agent.removeEventListener('activity', this.#onActivity)
		this.#agent.removeEventListener('dispose', this.#onAgentDispose)

		// Clean up UI
		this.#isWaitingForUserAnswer = false
		this.#stopHeaderUpdateLoop()
		this.wrapper.remove()
	}

	// ========== Private methods ==========

	#getToolExecutingText(toolName: string, args: unknown): string {
		const a = args as Record<string, string | number>
		switch (toolName) {
			case 'click_element_by_index':
				return this.#i18n.t('ui.tools.clicking', { index: a.index })
			case 'input_text':
				return this.#i18n.t('ui.tools.inputting', { index: a.index })
			case 'select_dropdown_option':
				return this.#i18n.t('ui.tools.selecting', { text: a.text })
			case 'scroll':
				return this.#i18n.t('ui.tools.scrolling')
			case 'wait':
				return this.#i18n.t('ui.tools.waiting', { seconds: a.seconds })
			case 'ask_user':
				return this.#i18n.t('ui.tools.askingUser')
			case 'done':
				return this.#i18n.t('ui.tools.done')
			default:
				return this.#i18n.t('ui.tools.executing', { toolName })
		}
	}

	/**
	 * Action button handler: stop when running, close (dispose) when idle
	 */
	#handleActionButton(): void {
		if (this.#agent.status === 'running') {
			this.#agent.stop()
		} else {
			this.#agent.dispose()
		}
	}

	/**
	 * Submit task
	 */
	#submitTask() {
		const input = this.#taskInput.value.trim()
		if (!input) return

		// Hide input area
		this.#hideInputArea()

		if (this.#isWaitingForUserAnswer) {
			// Handle user input mode
			this.#handleUserAnswer(input)
		} else {
			// Execute task via agent
			this.#agent.execute(input)
		}
	}

	/**
	 * Handle user answer
	 */
	#handleUserAnswer(input: string): void {
		// Remove temporary question cards (only direct children for safety)
		Array.from(this.#historySection.children).forEach((child) => {
			if (child.getAttribute('data-temp-card') === 'true') {
				child.remove()
			}
		})

		// Reset state
		this.#isWaitingForUserAnswer = false

		// Call resolver to return user input
		if (this.#userAnswerResolver) {
			this.#userAnswerResolver(input)
			this.#userAnswerResolver = null
		}
	}

	/**
	 * Show input area
	 */
	#showInputArea(placeholder?: string): void {
		// Clear input field
		this.#taskInput.value = ''
		this.#taskInput.placeholder = placeholder || this.#i18n.t('ui.panel.taskInput')
		this.#inputSection.classList.remove(styles.hidden)
		// Focus on input field
		setTimeout(() => {
			this.#taskInput.focus()
		}, 100)
	}

	/**
	 * Hide input area
	 */
	#hideInputArea(): void {
		this.#inputSection.classList.add(styles.hidden)
	}

	/**
	 * Check if input area should be shown
	 */
	#shouldShowInputArea(): boolean {
		// Always show input area if waiting for user input
		if (this.#isWaitingForUserAnswer) return true

		const history = this.#agent.history
		if (history.length === 0) {
			return true // Initial state
		}

		const status = this.#agent.status
		const isTaskEnded = status === 'completed' || status === 'error'

		// Only show input area after task completion if configured to do so
		if (isTaskEnded) {
			return this.#config.promptForNextTask ?? true
		}

		return false
	}

	#createWrapper(): HTMLElement {
		const wrapper = document.createElement('div')
		wrapper.id = 'page-agent-runtime_agent-panel'
		wrapper.className = styles.wrapper
		wrapper.setAttribute('data-browser-use-ignore', 'true')
		wrapper.setAttribute('data-page-agent-ignore', 'true')

		wrapper.innerHTML = `
			<div class="${styles.background}"></div>
			<div class="${styles.historySectionWrapper}">
				<div class="${styles.historySection}">
					<div class="${styles.historyItem}">
						<div class="${styles.historyContent}">
							<span class="${styles.statusIcon}">🧠</span>
							<span>${this.#i18n.t('ui.panel.waitingPlaceholder')}</span>
						</div>
					</div>
				</div>
			</div>
			<div class="${styles.header}">
				<div class="${styles.statusSection}">
					<div class="${styles.indicator} ${styles.thinking}"></div>
					<div class="${styles.statusText}">${this.#i18n.t('ui.panel.ready')}</div>
				</div>
				<div class="${styles.controls}">
					<button class="${styles.controlButton} ${styles.expandButton}" title="${this.#i18n.t('ui.panel.expand')}">
						▼
					</button>
					<button class="${styles.controlButton} ${styles.stopButton}" title="${this.#i18n.t('ui.panel.close')}">
						X
					</button>
				</div>
			</div>
			<div class="${styles.inputSectionWrapper} ${styles.hidden}">
				<div class="${styles.inputSection}">
					<input 
						type="text" 
						class="${styles.taskInput}" 
						maxlength="200"
					/>
				</div>
			</div>
		`

		document.body.appendChild(wrapper)
		return wrapper
	}

	#setupEventListeners(): void {
		// Click header area to expand/collapse
		const header = this.wrapper.querySelector(`.${styles.header}`)!
		header.addEventListener('click', (e) => {
			// Don't trigger expand/collapse if clicking on buttons
			if ((e.target as HTMLElement).closest(`.${styles.controlButton}`)) {
				return
			}
			this.#toggle()
		})

		// Expand button
		this.#expandButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#toggle()
		})

		// Action button (stop / close)
		this.#actionButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#handleActionButton()
		})

		// Submit on Enter key in input field
		this.#taskInput.addEventListener('keydown', (e) => {
			if (e.isComposing) return // Ignore IME composition keys
			if (e.key === 'Enter') {
				e.preventDefault()
				this.#submitTask()
			}
		})

		// Prevent input area click event bubbling
		this.#inputSection.addEventListener('click', (e) => {
			e.stopPropagation()
		})
	}

	#toggle(): void {
		if (this.#isExpanded) {
			this.#collapse()
		} else {
			this.#expand()
		}
	}

	#expand(): void {
		this.#isExpanded = true
		this.wrapper.classList.add(styles.expanded)
		this.#expandButton.textContent = '▲'
	}

	#collapse(): void {
		this.#isExpanded = false
		this.wrapper.classList.remove(styles.expanded)
		this.#expandButton.textContent = '▼'
	}

	/**
	 * Start periodic header update loop
	 */
	#startHeaderUpdateLoop(): void {
		// Check every 450ms (same as total animation duration)
		this.#headerUpdateTimer = setInterval(() => {
			this.#checkAndUpdateHeader()
		}, 450)
	}

	/**
	 * Stop periodic header update loop
	 */
	#stopHeaderUpdateLoop(): void {
		if (this.#headerUpdateTimer) {
			clearInterval(this.#headerUpdateTimer)
			this.#headerUpdateTimer = null
		}
	}

	/**
	 * Check if header needs update and trigger animation if not currently animating
	 */
	#checkAndUpdateHeader(): void {
		// If no pending text or currently animating, skip
		if (!this.#pendingHeaderText || this.#isAnimating) {
			return
		}

		// If text is already displayed, clear pending and skip
		if (this.#statusText.textContent === this.#pendingHeaderText) {
			this.#pendingHeaderText = null
			return
		}

		// Start animation
		const textToShow = this.#pendingHeaderText
		this.#pendingHeaderText = null
		this.#animateTextChange(textToShow)
	}

	/**
	 * Animate text change with fade out/in effect
	 */
	#animateTextChange(newText: string): void {
		this.#isAnimating = true

		// Fade out current text
		this.#statusText.classList.add(styles.fadeOut)

		setTimeout(() => {
			// Update text content
			this.#statusText.textContent = newText

			// Fade in new text
			this.#statusText.classList.remove(styles.fadeOut)
			this.#statusText.classList.add(styles.fadeIn)

			setTimeout(() => {
				this.#statusText.classList.remove(styles.fadeIn)
				this.#isAnimating = false
			}, 300)
		}, 150) // Half the duration of fade out animation
	}

	#updateStatusIndicator(
		type: 'thinking' | 'executing' | 'executed' | 'retrying' | 'completed' | 'error'
	): void {
		// Clear all status classes
		this.#indicator.className = styles.indicator

		// Add corresponding status class
		this.#indicator.classList.add(styles[type])
	}

	#scrollToBottom(): void {
		// Execute in next event loop to ensure DOM update completion
		setTimeout(() => {
			this.#historySection.scrollTop = this.#historySection.scrollHeight
		}, 0)
	}

	/**
	 * Render history directly from agent.history
	 *
	 * Renders:
	 * 1. Task (first item, from agent.task)
	 * 2. Reflection cards (evaluation, memory, next_goal)
	 * 3. Tool execution with output
	 * 4. Observations
	 */
	#renderHistory(): void {
		const items: string[] = []

		// 1. Task card (always first)
		const task = this.#agent.task
		if (task) {
			items.push(this.#createTaskCard(task))
		}

		// 2. Render each history event
		const history = this.#agent.history
		for (const event of history) {
			items.push(...this.#createHistoryCards(event))
		}

		this.#historySection.innerHTML = items.join('')
		this.#scrollToBottom()
	}

	#createTaskCard(task: string): string {
		return createCard({ icon: '🎯', content: task, type: 'input' })
	}

	/** Create cards for a history event */
	#createHistoryCards(event: PanelAgentAdapter['history'][number]): string[] {
		const cards: string[] = []
		const meta =
			event.type === 'step' && event.stepIndex !== undefined
				? this.#i18n.t('ui.panel.step', {
						number: (event.stepIndex + 1).toString(),
					})
				: undefined

		if (event.type === 'step') {
			// Reflection card
			if (event.reflection) {
				const lines = createReflectionLines(event.reflection)
				if (lines.length > 0) {
					cards.push(createCard({ icon: '🧠', content: lines, meta }))
				}
			}

			// Action card
			const action = event.action
			if (action) {
				cards.push(...this.#createActionCards(action, meta))
			}
		} else if (event.type === 'observation') {
			cards.push(
				createCard({ icon: '👁️', content: event.content || '', meta, type: 'observation' })
			)
		} else if (event.type === 'user_takeover') {
			cards.push(createCard({ icon: '👤', content: 'User takeover', meta, type: 'input' }))
		} else if (event.type === 'retry') {
			const retryInfo = `${event.message || 'Retrying'} (${event.attempt}/${event.maxAttempts})`
			cards.push(createCard({ icon: '🔄', content: retryInfo, meta, type: 'observation' }))
		} else if (event.type === 'error') {
			cards.push(
				createCard({ icon: '❌', content: event.message || 'Error', meta, type: 'observation' })
			)
		}

		return cards
	}

	/** Create cards for an action */
	#createActionCards(
		action: { name: string; input: unknown; output: string },
		meta?: string
	): string[] {
		const cards: string[] = []

		if (action.name === 'done') {
			const input = action.input as { text?: string }
			const text = input.text || action.output || ''
			if (text) {
				cards.push(createCard({ icon: '🤖', content: text, meta, type: 'output' }))
			}
		} else if (action.name === 'ask_user') {
			const input = action.input as { question?: string }
			const answer = action.output.replace(/^User answered:\s*/i, '')
			cards.push(
				createCard({
					icon: '❓',
					content: `Question: ${input.question || ''}`,
					meta,
					type: 'question',
				})
			)
			cards.push(createCard({ icon: '💬', content: `Answer: ${answer}`, meta, type: 'input' }))
		} else {
			const toolText = this.#getToolExecutingText(action.name, action.input)
			cards.push(createCard({ icon: '🔨', content: toolText, meta }))
			if (action.output?.length > 0) {
				cards.push(createCard({ icon: '🔨', content: action.output, meta, type: 'output' }))
			}
		}

		return cards
	}

	// ========== Workflow UI Methods ==========

	/** Remove all workflow UI elements */
	#hideWorkflowUI(): void {
		this.#historySection.querySelectorAll(`[data-workflow-ui]`).forEach((el) => el.remove())
	}

	/** Show workflow action buttons after task completion */
	#showWorkflowBar(): void {
		this.#hideWorkflowUI()

		const bar = document.createElement('div')
		bar.className = styles.workflowBar
		bar.setAttribute('data-workflow-ui', 'true')

		// Save button
		const saveBtn = document.createElement('button')
		saveBtn.className = `${styles.workflowBtn} ${styles.primary}`
		saveBtn.textContent = `💾 ${this.#i18n.t('ui.workflow.saveWorkflow')}`
		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#showWorkflowSaveDialog()
		})
		bar.appendChild(saveBtn)

		// List button
		if (this.#agent.onListWorkflows) {
			const listBtn = document.createElement('button')
			listBtn.className = styles.workflowBtn
			listBtn.textContent = `📋 ${this.#i18n.t('ui.workflow.workflowList')}`
			listBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				this.#showWorkflowList()
			})
			bar.appendChild(listBtn)
		}

		this.#historySection.appendChild(bar)
		this.#scrollToBottom()
	}

	/** Show the save dialog (name input) */
	#showWorkflowSaveDialog(): void {
		this.#hideWorkflowUI()

		const dialog = document.createElement('div')
		dialog.className = styles.workflowSaveDialog
		dialog.setAttribute('data-workflow-ui', 'true')

		const input = document.createElement('input')
		input.className = styles.workflowSaveInput
		input.type = 'text'
		input.placeholder = this.#i18n.t('ui.workflow.enterName')
		input.maxLength = 50
		dialog.appendChild(input)

		const actions = document.createElement('div')
		actions.className = styles.workflowSaveActions

		const cancelBtn = document.createElement('button')
		cancelBtn.className = styles.workflowBtn
		cancelBtn.textContent = this.#i18n.t('ui.workflow.back')
		cancelBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#showWorkflowBar()
		})
		actions.appendChild(cancelBtn)

		const confirmBtn = document.createElement('button')
		confirmBtn.className = `${styles.workflowBtn} ${styles.primary}`
		confirmBtn.textContent = `💾 ${this.#i18n.t('ui.workflow.saveWorkflow')}`
		confirmBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			const name = input.value.trim()
			if (!name) return
			const id = this.#agent.onSaveWorkflow?.(name)
			if (id) {
				// Show success feedback
				this.#hideWorkflowUI()
				const msg = document.createElement('div')
				msg.setAttribute('data-workflow-ui', 'true')
				msg.innerHTML = createCard({
					icon: '✅',
					content: this.#i18n.t('ui.workflow.workflowSaved'),
					type: 'output',
				})
				this.#historySection.appendChild(msg)
				this.#scrollToBottom()
				// Re-show workflow bar after a moment
				setTimeout(() => this.#showWorkflowBar(), 1500)
			}
		})
		actions.appendChild(confirmBtn)

		// Submit on Enter
		input.addEventListener('keydown', (e) => {
			if (e.isComposing) return
			if (e.key === 'Enter') {
				e.preventDefault()
				confirmBtn.click()
			}
		})

		dialog.appendChild(actions)
		this.#historySection.appendChild(dialog)
		this.#scrollToBottom()
		setTimeout(() => input.focus(), 100)
	}

	/** Show the workflow list view */
	#showWorkflowList(): void {
		if (!this.#agent.onListWorkflows) return

		this.#hideWorkflowUI()

		const section = document.createElement('div')
		section.className = styles.workflowListSection
		section.setAttribute('data-workflow-ui', 'true')

		// Header with back button
		const header = document.createElement('div')
		header.className = styles.workflowListHeader

		const title = document.createElement('span')
		title.className = styles.workflowListTitle
		title.textContent = `📋 ${this.#i18n.t('ui.workflow.workflowList')}`
		header.appendChild(title)

		const backBtn = document.createElement('button')
		backBtn.className = styles.workflowBackBtn
		backBtn.textContent = `← ${this.#i18n.t('ui.workflow.back')}`
		backBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#showWorkflowBar()
		})
		header.appendChild(backBtn)
		section.appendChild(header)

		// Import button
		if (this.#agent.onImportWorkflow) {
			const importBtn = document.createElement('button')
			importBtn.className = styles.workflowImportBtn
			importBtn.textContent = `📥 ${this.#i18n.t('ui.workflow.importWorkflow')}`
			importBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				this.#triggerWorkflowImport()
			})
			section.appendChild(importBtn)
		}

		// Workflow items
		const workflows = this.#agent.onListWorkflows()

		if (workflows.length === 0) {
			const empty = document.createElement('div')
			empty.className = styles.workflowEmpty
			empty.textContent = this.#i18n.t('ui.workflow.noWorkflows')
			section.appendChild(empty)
		} else {
			for (const wf of workflows) {
				section.appendChild(this.#createWorkflowItem(wf))
			}
		}

		this.#historySection.appendChild(section)
		this.#scrollToBottom()
	}

	/** Create a single workflow list item */
	#createWorkflowItem(wf: {
		id: string
		name: string
		steps: number
		updatedAt: string
	}): HTMLElement {
		const item = document.createElement('div')
		item.className = styles.workflowItem

		// Info
		const info = document.createElement('div')
		info.className = styles.workflowItemInfo

		const name = document.createElement('div')
		name.className = styles.workflowItemName
		name.textContent = wf.name
		info.appendChild(name)

		const meta = document.createElement('div')
		meta.className = styles.workflowItemMeta
		const date = new Date(wf.updatedAt)
		meta.textContent = `${wf.steps} steps · ${date.toLocaleDateString()}`
		info.appendChild(meta)

		item.appendChild(info)

		// Action buttons
		const actions = document.createElement('div')
		actions.className = styles.workflowItemActions

		// Play
		if (this.#agent.onPlayWorkflow) {
			const playBtn = document.createElement('button')
			playBtn.className = `${styles.workflowActionBtn} ${styles.playBtn}`
			playBtn.textContent = `▶ ${this.#i18n.t('ui.workflow.playWorkflow')}`
			playBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				this.#playWorkflow(wf.id)
			})
			actions.appendChild(playBtn)
		}

		// Export
		if (this.#agent.onExportWorkflow) {
			const exportBtn = document.createElement('button')
			exportBtn.className = styles.workflowActionBtn
			exportBtn.textContent = `📤`
			exportBtn.title = this.#i18n.t('ui.workflow.exportWorkflow')
			exportBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				this.#agent.onExportWorkflow?.(wf.id)
			})
			actions.appendChild(exportBtn)
		}

		// Delete
		if (this.#agent.onDeleteWorkflow) {
			const deleteBtn = document.createElement('button')
			deleteBtn.className = `${styles.workflowActionBtn} ${styles.deleteBtn}`
			deleteBtn.textContent = `🗑`
			deleteBtn.title = this.#i18n.t('ui.workflow.deleteWorkflow')
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				if (confirm(this.#i18n.t('ui.workflow.confirmDelete'))) {
					this.#agent.onDeleteWorkflow?.(wf.id)
					this.#showWorkflowList() // Refresh
				}
			})
			actions.appendChild(deleteBtn)
		}

		item.appendChild(actions)
		return item
	}

	/** Trigger file input for workflow import */
	#triggerWorkflowImport(): void {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = '.json'
		input.style.display = 'none'
		input.addEventListener('change', async () => {
			const file = input.files?.[0]
			if (file && this.#agent.onImportWorkflow) {
				const id = await this.#agent.onImportWorkflow(file)
				if (id) {
					this.#showWorkflowList() // Refresh list
				}
			}
			input.remove()
		})
		document.body.appendChild(input)
		input.click()
	}

	/** Start playing a workflow */
	async #playWorkflow(id: string): Promise<void> {
		if (!this.#agent.onPlayWorkflow) return

		this.#hideWorkflowUI()
		this.#hideInputArea()

		// Show playing status
		this.#pendingHeaderText = '▶ Playing workflow...'
		this.#updateStatusIndicator('executing')

		try {
			const result = await this.#agent.onPlayWorkflow(id)

			// Show result
			const msg = document.createElement('div')
			msg.setAttribute('data-workflow-ui', 'true')
			msg.innerHTML = createCard({
				icon: result.success ? '✅' : '❌',
				content: result.message,
				type: result.success ? 'output' : 'observation',
			})
			this.#historySection.appendChild(msg)
			this.#scrollToBottom()
		} catch (err) {
			const msg = document.createElement('div')
			msg.setAttribute('data-workflow-ui', 'true')
			msg.innerHTML = createCard({
				icon: '❌',
				content: String(err),
				type: 'observation',
			})
			this.#historySection.appendChild(msg)
			this.#scrollToBottom()
		}

		this.#updateStatusIndicator('completed')
		this.#pendingHeaderText = this.#i18n.t('ui.panel.ready')
		this.#showWorkflowBar()
		if (this.#shouldShowInputArea()) {
			this.#showInputArea()
		}
	}
}
