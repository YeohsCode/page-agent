/**
 * Element matching engine for workflow replay.
 *
 * When replaying a workflow, element indices from the recording are likely stale.
 * This module re-locates elements using multiple strategies stored in ElementSelector.
 */
import type { ElementSelector } from './types'

/**
 * Score-based matching result
 */
interface MatchCandidate {
	element: HTMLElement
	score: number
}

/**
 * Find the best matching element in the current DOM for a given selector.
 *
 * Matching strategies (scored, highest wins):
 * 1. CSS selector exact match           (+10)
 * 2. id attribute match                 (+10)
 * 3. aria-label match                   (+6)
 * 4. tag + textContent match            (+5)
 * 5. tag + placeholder/name match       (+4)
 * 6. tag only match                     (+1)
 *
 * @returns The best matching element, or null if no match found
 */
export function findElement(selector: ElementSelector): HTMLElement | null {
	const candidates = scoreCandidates(selector)

	if (candidates.length === 0) return null

	// Sort by score descending
	candidates.sort((a, b) => b.score - a.score)

	const best = candidates[0]
	// Require minimum score of 4 to avoid false matches
	if (best.score < 4) return null

	return best.element
}

/**
 * Score all interactive elements against the selector
 */
function scoreCandidates(selector: ElementSelector): MatchCandidate[] {
	const candidates: MatchCandidate[] = []

	// Strategy 1: CSS selector (most precise, standalone)
	if (selector.cssSelector) {
		try {
			const el = document.querySelector<HTMLElement>(selector.cssSelector)
			if (el) {
				candidates.push({ element: el, score: 10 })
				return candidates // CSS selector is definitive
			}
		} catch {
			// Invalid CSS selector, fall through to other strategies
		}
	}

	// Strategy 2: id attribute (also very precise)
	if (selector.attributes?.id) {
		const el = document.getElementById(selector.attributes.id)
		if (el) {
			candidates.push({ element: el as HTMLElement, score: 10 })
			return candidates // id is definitive
		}
	}

	// For remaining strategies, gather all candidate elements
	const tagFilter = selector.tagName?.toLowerCase()
	const allElements = tagFilter
		? Array.from(document.querySelectorAll<HTMLElement>(tagFilter))
		: Array.from(
				document.querySelectorAll<HTMLElement>(
					'button, input, select, textarea, a, [role="button"], [tabindex]'
				)
			)

	for (const el of allElements) {
		let score = 0

		// Tag name match
		if (selector.tagName && el.tagName.toLowerCase() === selector.tagName.toLowerCase()) {
			score += 1
		}

		// aria-label match
		if (selector.ariaLabel) {
			const label = el.getAttribute('aria-label')
			if (label && label.trim() === selector.ariaLabel.trim()) {
				score += 6
			}
		}

		// Text content match
		if (selector.textContent) {
			const text = el.textContent?.trim()
			if (text && text === selector.textContent.trim()) {
				score += 5
			} else if (text && text.includes(selector.textContent.trim())) {
				score += 3 // Partial match
			}
		}

		// Attribute matches (name, placeholder, type, role, etc.)
		if (selector.attributes) {
			for (const [key, value] of Object.entries(selector.attributes)) {
				if (key === 'id') continue // Already handled above
				const attrValue = el.getAttribute(key)
				if (attrValue && attrValue === value) {
					score += 4
				}
			}
		}

		if (score > 0) {
			candidates.push({ element: el, score })
		}
	}

	return candidates
}

/**
 * Extract an ElementSelector from a live DOM element.
 * Used during recording to capture locator data for future replay.
 */
export function extractSelector(element: HTMLElement): ElementSelector {
	const selector: ElementSelector = {}

	// Tag name
	selector.tagName = element.tagName.toLowerCase()

	// Text content (trimmed, truncated to 200 chars for sanity)
	const text = element.textContent?.trim()
	if (text && text.length > 0 && text.length <= 200) {
		selector.textContent = text
	}

	// aria-label
	const ariaLabel = element.getAttribute('aria-label')
	if (ariaLabel) {
		selector.ariaLabel = ariaLabel
	}

	// Key attributes
	const attrs: Record<string, string> = {}
	const attrNames = ['id', 'name', 'placeholder', 'type', 'role', 'data-testid', 'href']
	for (const name of attrNames) {
		const value = element.getAttribute(name)
		if (value) {
			attrs[name] = value
		}
	}
	if (Object.keys(attrs).length > 0) {
		selector.attributes = attrs
	}

	// CSS selector (try to build a unique path)
	try {
		selector.cssSelector = buildCssSelector(element)
	} catch {
		// Fallback: no CSS selector
	}

	return selector
}

/**
 * Build a reasonably unique CSS selector for an element.
 * Walks up the DOM tree collecting tag names and relevant attributes.
 */
function buildCssSelector(element: HTMLElement): string {
	// If element has an id, use it directly
	if (element.id) {
		return `#${CSS.escape(element.id)}`
	}

	const parts: string[] = []
	let current: HTMLElement | null = element

	while (current && current !== document.body && parts.length < 5) {
		let part = current.tagName.toLowerCase()

		if (current.id) {
			part = `#${CSS.escape(current.id)}`
			parts.unshift(part)
			break // id is unique, stop here
		}

		// Add distinguishing attributes
		const classNames = Array.from(current.classList)
			.filter((c) => !c.startsWith('_') && c.length < 30)
			.slice(0, 2)

		if (classNames.length > 0) {
			part += classNames.map((c) => `.${CSS.escape(c)}`).join('')
		}

		// Add nth-child if needed for disambiguation
		const parent = current.parentElement
		if (parent) {
			const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName)
			if (siblings.length > 1) {
				const index = siblings.indexOf(current) + 1
				part += `:nth-child(${index})`
			}
		}

		parts.unshift(part)
		current = current.parentElement
	}

	return parts.join(' > ')
}
