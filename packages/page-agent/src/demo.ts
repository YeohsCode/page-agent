/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'

// Clean up existing instances to prevent multiple injections from bookmarklet
if (window.pageAgent) {
	window.pageAgent.dispose()
}

// Mount to global window object
window.PageAgent = PageAgent

console.log('🚀 page-agent.js loaded!')

const DEMO_MODEL = 'qwen3.5-plus'
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_API_KEY = 'NA'

// wait for document body to be fully loaded to prevent SPA re-rendering from wiping out the injected UI
function initAgent() {
	if (document.readyState !== 'complete') {
		window.addEventListener('load', initAgent);
		return;
	}

	const currentScript = document.currentScript as HTMLScriptElement | null
	let config: PageAgentConfig

	// 1. Priority: Check for Tauri/Injection config
	if ((window as any).PAGE_AGENT_CONFIG) {
		console.log('🚀 [Tauri] Detected injected PAGE_AGENT_CONFIG');
		config = (window as any).PAGE_AGENT_CONFIG;
	}
	// 2. Secondary: Check for script tag URL params
	else if (currentScript) {
		console.log('🚀 page-agent.js detected current script:', currentScript.src)
		const url = new URL(currentScript.src)
		const model = url.searchParams.get('model') || DEMO_MODEL
		const baseURL = url.searchParams.get('baseURL') || DEMO_BASE_URL
		const apiKey = url.searchParams.get('apiKey') || DEMO_API_KEY
		const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
		config = { model, baseURL, apiKey, language }
	}
	// 3. Fallback: Demo defaults
	else {
		console.log('🚀 page-agent.js no current script detected, using default demo config')
		config = {
			model: import.meta.env.LLM_MODEL_NAME ? import.meta.env.LLM_MODEL_NAME : DEMO_MODEL,
			baseURL: import.meta.env.LLM_BASE_URL ? import.meta.env.LLM_BASE_URL : DEMO_BASE_URL,
			apiKey: import.meta.env.LLM_API_KEY ? import.meta.env.LLM_API_KEY : DEMO_API_KEY,
		}
	}

	// Create agent
	try {
		console.log('🚀 page-agent.js creating PageAgent with:', config);
		window.pageAgent = new PageAgent(config);
		// Force display
		setTimeout(() => {
			if (window.pageAgent) {
				window.pageAgent.panel.show();
			}
		}, 500);
		console.log('🚀 page-agent.js instance created successfully');
	} catch (e) {
		console.error('❌ page-agent.js failed to create PageAgent:', e);
	}
}

initAgent();
