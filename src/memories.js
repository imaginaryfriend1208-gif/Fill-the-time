import { extension_settings, getContext } from "../../../../extensions.js";
import { MacrosParser, evaluateMacros } from "../../../../macros.js";
import { getRegexedString, regex_placement } from '../../../regex/engine.js';
import { getCharaFilename, escapeRegex, trimSpaces } from "../../../../utils.js";
import { settings, ChapterEndMode } from "./settings.js";
import { toggleChapterHighlight } from "./messages.js";
import { debug } from "./logging.js";
import { ConnectionManagerRequestService } from "../../../shared.js";
import { amount_gen, main_api, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "../../../../../script.js";
import { oai_settings, openai_settings, chat_completion_sources, reasoning_effort_types } from "../../../../../scripts/openai.js";
import { reasoning_templates } from "../../../../../scripts/reasoning.js";
import { getPresetManager } from "../../../../../scripts/preset-manager.js";
import { isAgenticTimelineFillActive } from "./agentic-timeline-fill.js";
import { updateRetrievalProgress, isProgressVisible } from "./retrieval-progress.js";
import { showLoadingScreen, hideLoadingScreen } from "./loading-screen.js";
import { translate } from "../../../../../scripts/i18n.js";
import { createChatBackup } from "./backup.js";


// --- Resilient API fallback wrapper ---
async function sendReliableApiRequest(profileId, messages, maxTokens, options, overridePayload) {
	if (profileId && typeof ConnectionManagerRequestService !== 'undefined' && ConnectionManagerRequestService) {
		try {
			const result = await ConnectionManagerRequestService.sendRequest(
				profileId, messages, maxTokens, options, overridePayload
			);
			return result;
		} catch (err) {
			debug("ConnectionManagerRequestService failed, falling back to standard API:", err);
		}
	}
	// Fallback: use SillyTavern's native generateQuietPrompt
	const { generateQuietPrompt } = await import("../../../../../script.js");
	const formattedPrompt = messages.map(m => m.content).join("\n\n");
	const res = await generateQuietPrompt({ quietPrompt: formattedPrompt });
	return { content: res };
}
// -------------------------------------

const runSlashCommand = getContext().executeSlashCommandsWithOptions;
const CHAT_COMPLETION_APIS = ['claude', 'openrouter', 'windowai', 'scale', 'ai21', 'makersuite', 'vertexai', 'mistralai', 'custom', 'google', 'cohere', 'perplexity', 'groq', '01ai', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations', 'moonshot', 'zai'];

/**
 * Get the reasoning effort value based on the profile's chat completion source.
 * This replicates the logic from SillyTavern's openai.js getReasoningEffort function.
 * @param {string} profileId - The connection profile ID
 * @returns {string|undefined} The reasoning effort value to use
 */
export function getReasoningEffort(profileId) {
	// Get profile settings
	try {
		const profiles = extension_settings?.connectionManager?.profiles || [];
		const profile = profiles.find(p => p.id === profileId);

		if (!profile) {
			debug('Profile not found for reasoning effort:', profileId);
			// Fallback to current settings
			return oai_settings.reasoning_effort;
		}

		// Get preset settings to find reasoning_effort
		let reasoningEffort = null;
		if (profile.preset) {
			// Claude and other chat completion sources use the 'openai' preset manager
			let presetManagerApi = profile.api;

			if (CHAT_COMPLETION_APIS.includes(profile.api) || profile.api === 'openai') {
				presetManagerApi = 'openai';
			}

			const presetManager = getPresetManager(presetManagerApi);
			if (presetManager) {
				// Get preset settings
				if (presetManagerApi === 'openai') {
					const openaiPresets = presetManager.getAllPresets();
					const presetIndex = openaiPresets.indexOf(profile.preset);

					if (presetIndex >= 0 && openai_settings[presetIndex]) {
						reasoningEffort = openai_settings[presetIndex].reasoning_effort;
						debug('Found reasoning effort from preset:', reasoningEffort);
					}
				}
			}
		}

		// If no reasoning effort in preset, use current settings
		if (!reasoningEffort) {
			reasoningEffort = oai_settings.reasoning_effort;
			debug('Using default reasoning effort:', reasoningEffort);
		}

		// Map the API type to chat completion source for proper value conversion
		const apiToSource = {
			'openai': chat_completion_sources.OPENAI,
			'claude': chat_completion_sources.CLAUDE,
			'openrouter': chat_completion_sources.OPENROUTER,
			'ai21': chat_completion_sources.AI21,
			'makersuite': chat_completion_sources.MAKERSUITE,
			'vertexai': chat_completion_sources.VERTEXAI,
			'google': chat_completion_sources.VERTEXAI,
			'mistralai': chat_completion_sources.MISTRALAI,
			'custom': chat_completion_sources.CUSTOM,
			'cohere': chat_completion_sources.COHERE,
			'perplexity': chat_completion_sources.PERPLEXITY,
			'groq': chat_completion_sources.GROQ,
			'deepseek': chat_completion_sources.DEEPSEEK,
			'aimlapi': chat_completion_sources.AIMLAPI,
			'xai': chat_completion_sources.XAI,
			'pollinations': chat_completion_sources.POLLINATIONS,
		};

		const source = apiToSource[profile.api] || profile.api;

		// These sources expect the effort as string
		const reasoningEffortSources = [
			chat_completion_sources.OPENAI,
			chat_completion_sources.CUSTOM,
			chat_completion_sources.XAI,
			chat_completion_sources.AIMLAPI,
			chat_completion_sources.OPENROUTER,
			chat_completion_sources.POLLINATIONS,
			chat_completion_sources.PERPLEXITY,
			chat_completion_sources.COMETAPI,
		];

		if (!reasoningEffortSources.includes(source)) {
			return reasoningEffort;
		}

		// Apply value mapping based on source
		switch (reasoningEffort) {
			case reasoning_effort_types.auto:
				return undefined;
			case reasoning_effort_types.min:
				// Check if we're using OpenAI with a gpt-5 model
				if (source === chat_completion_sources.OPENAI && profile.model?.startsWith('gpt-5')) {
					return 'min';
				}
				return 'low';
			case reasoning_effort_types.max:
				return 'high';
			default:
				return reasoningEffort;
		}
	} catch (error) {
		debug('Error getting reasoning effort for profile:', error);
		// Fallback to current settings
		return oai_settings.reasoning_effort;
	}
}

/**
 * Determine whether to include reasoning content for a profile.
 * Currently only applies to z.ai which expects an explicit thinking flag.
 * @param {string} profileId - The connection profile ID
 * @returns {boolean|undefined} True/false for include_reasoning, or undefined when not applicable
 */
export function getIncludeReasoning(profileId) {
	try {
		const profiles = extension_settings?.connectionManager?.profiles || [];
		const profile = profiles.find(p => p.id === profileId);

		if (!profile) {
			debug('Profile not found for include_reasoning:', profileId);
			return undefined;
		}

		if (profile.api !== 'zai') {
			return undefined;
		}

		let includeReasoning = null;

		if (profile.preset) {
			let presetManagerApi = profile.api;
			if (CHAT_COMPLETION_APIS.includes(profile.api) || profile.api === 'openai') {
				presetManagerApi = 'openai';
			}

			const presetManager = getPresetManager(presetManagerApi);
			if (presetManager) {
				if (presetManagerApi === 'openai') {
					const openaiPresets = presetManager.getAllPresets();
					const presetIndex = openaiPresets.indexOf(profile.preset);

					if (presetIndex >= 0 && openai_settings[presetIndex]) {
						includeReasoning = openai_settings[presetIndex].show_thoughts;
						debug('Found include_reasoning from preset:', includeReasoning);
					}
				} else {
					const presetSettings = presetManager.getPresetSettings(profile.preset);
					if (presetSettings && typeof presetSettings.show_thoughts === 'boolean') {
						includeReasoning = presetSettings.show_thoughts;
						debug('Found include_reasoning from preset:', includeReasoning);
					}
				}
			}
		}

		if (includeReasoning === null || includeReasoning === undefined) {
			includeReasoning = oai_settings.show_thoughts;
			debug('Using default include_reasoning:', includeReasoning);
		}

		return Boolean(includeReasoning);
	} catch (error) {
		debug('Error getting include_reasoning for profile:', error);
		return undefined;
	}
}

// Store timeline data
let timelineData = [];
let timelineFillResults = [];
let currentChatContent = null; // Captured chat content for {{currentChat}} macro

// Flag to track when we're doing internal generations (queries, etc.)
// This is used to prevent timeline injection during these operations
let isInternalGeneration = false;

let commandArgs;

const infoToast = (text) => { if (!commandArgs?.quiet) toastr.info(text, "Timeline Memory") };
const doneToast = (text) => { if (!commandArgs?.quiet) toastr.success(text, "Timeline Memory") };
const oopsToast = (text) => { if (!commandArgs?.quiet) toastr.warning(text, "Timeline Memory") };
const errorToast = (text) => { if (!commandArgs?.quiet) toastr.error(text, "Timeline Memory") };

const delay_ms = () => {
	return Math.max(500, 60000 / Number(settings.rate_limit));
}
let last_gen_timestamp = 0;

export function getTimelineFillResults() {
	return Array.isArray(timelineFillResults) ? [...timelineFillResults] : [];
}

// Save timeline fill results to chat metadata
async function saveTimelineFillResults() {
	const context = getContext();
	if (!context.chatMetadata) {
		context.chatMetadata = {};
	}
	context.chatMetadata.timelineFillResults = timelineFillResults;
	await context.saveMetadata();
}

export async function setTimelineFillResults(results) {
	if (Array.isArray(results)) {
		timelineFillResults = [...results];
	} else {
		timelineFillResults = [];
	}
	await saveTimelineFillResults();
	// Update injection prompt with new data
	updateTimelineInjection();
}

export async function resetTimelineFillResults() {
	timelineFillResults = [];
	await saveTimelineFillResults();
	// Update injection prompt with new data
	updateTimelineInjection();
}

/**
 * Get the current chat content captured at start of agentic timeline fill session
 * @returns {string|null} The chat content or null
 */
export function getCurrentChatContent() {
	return currentChatContent;
}

/**
 * Set the current chat content (called by agentic-timeline-fill.js)
 * @param {string|null} content - The chat content to store
 */
export function setCurrentChatContent(content) {
	currentChatContent = content;
	debug('Set currentChatContent:', content ? `${content.length} chars` : 'null');
}

/**
 * Clear the current chat content
 */
export function clearCurrentChatContent() {
	currentChatContent = null;
	debug('Cleared currentChatContent');
}

export function getTimelineEntries() {
	return Array.isArray(timelineData) ? [...timelineData] : [];
}

function getChapterEffectiveRangeByIndex(chapterIndex) {
	if (chapterIndex < 0 || chapterIndex >= timelineData.length) {
		return null;
	}
	const chapter = timelineData[chapterIndex];
	const previousChapter = chapterIndex > 0 ? timelineData[chapterIndex - 1] : null;
	const startMsgId = previousChapter ? previousChapter.endMsgId + 1 : 0;
	const endMsgId = chapter.endMsgId;
	return {
		startMsgId,
		endMsgId,
		messageCount: Math.max(0, endMsgId - startMsgId + 1),
	};
}

export function getChapterEffectiveRange(chapterNumber) {
	return getChapterEffectiveRangeByIndex(Number(chapterNumber) - 1);
}

/**
 * Get the max tokens setting for the current connection or a specific profile
 * @param {string} profileId - The connection profile ID (optional)
 * @returns {Promise<number>} The max tokens value
 */
export async function getMaxTokensForProfile(profileId) {
	if (!profileId || profileId === 'current') {
		// Use current settings based on active API
		switch (main_api) {
			case 'openai':
			case 'openrouter':
			case 'claude':
			case 'windowai':
			case 'scale':
			case 'ai21':
			case 'makersuite':
			case 'vertexai':
			case 'mistralai':
			case 'custom':
			case 'cohere':
			case 'perplexity':
			case 'groq':
			case '01ai':
			case 'nanogpt':
			case 'deepseek':
			case 'aimlapi':
			case 'xai':
			case 'pollinations':
			case 'moonshot':
			case 'zai':
				// All chat completion sources use openai_max_tokens
				return oai_settings.openai_max_tokens || amount_gen || 2048;
			default:
				return amount_gen || 2048;
		}
	}

	// For specific profiles, try to get from profile settings
	try {
		const profiles = extension_settings?.connectionManager?.profiles || [];
		const profile = profiles.find(p => p.id === profileId);

		if (!profile) {
			debug('Profile not found:', profileId);
			return amount_gen || 2048;
		}

		debug('Found profile:', profile.name, 'API:', profile.api, 'Preset:', profile.preset);

		// If profile has a preset, try to get max tokens from it
		if (profile.preset) {
			// Claude and other chat completion sources use the 'openai' preset manager
			let presetManagerApi = profile.api;

			if (CHAT_COMPLETION_APIS.includes(profile.api) || profile.api === 'openai') {
				presetManagerApi = 'openai';
				debug('Using openai preset manager for chat completion API:', profile.api);
			}

			const presetManager = getPresetManager(presetManagerApi);
			if (!presetManager) {
				debug('No preset manager found for API:', presetManagerApi);
				return amount_gen || 2048;
			}

			// Get preset settings
			let presetSettings = null;

			if (presetManagerApi === 'openai') {
				// For OpenAI-based APIs, we need to get the preset from openai_settings
				const openaiPresets = presetManager.getAllPresets();
				const presetIndex = openaiPresets.indexOf(profile.preset);

				if (presetIndex >= 0 && openai_settings[presetIndex]) {
					presetSettings = openai_settings[presetIndex];
					debug('Found OpenAI preset at index:', presetIndex);
				} else {
					debug('OpenAI preset not found in list:', profile.preset);
					return amount_gen || 2048;
				}
			} else {
				// For other APIs, use the normal method
				presetSettings = presetManager.getPresetSettings(profile.preset);
				if (!presetSettings) {
					debug('No preset settings found for preset:', profile.preset);
					return amount_gen || 2048;
				}
			}

			// Get max tokens from preset based on API type
			let maxTokens = null;
			switch (profile.api) {
				case 'openai':
				case 'openrouter':
				case 'claude':
				case 'windowai':
				case 'scale':
				case 'ai21':
				case 'makersuite':
				case 'vertexai':
				case 'mistralai':
				case 'google':
				case 'custom':
				case 'cohere':
				case 'perplexity':
				case 'groq':
				case '01ai':
				case 'nanogpt':
				case 'deepseek':
				case 'aimlapi':
				case 'xai':
				case 'pollinations':
				case 'moonshot':
				case 'zai':
					// All chat completion sources use openai_max_tokens
					maxTokens = presetSettings.openai_max_tokens;
					debug('Chat completion max tokens (openai_max_tokens):', maxTokens);
					break;
				default:
					// Generic fallback
					maxTokens = presetSettings.max_tokens || presetSettings.max_length || presetSettings.genamt;
					debug('Generic max tokens:', maxTokens);
			}

			if (maxTokens !== null && maxTokens !== undefined) {
				return maxTokens;
			}
		} else {
			debug('Profile has no preset');
		}
	} catch (error) {
		debug('Error getting max tokens for profile:', error);
	}

	return amount_gen || 2048;
}

/**
 * Build override payload for ConnectionManagerRequestService based on profile API
 * @param {string} profileId - The connection profile ID
 * @param {number} maxTokens - The max tokens value
 * @returns {object} Override payload for the request
 */
export function buildOverridePayload(profileId, maxTokens) {
	try {
		const profiles = extension_settings?.connectionManager?.profiles || [];
		const profile = profiles.find(p => p.id === profileId);

		if (profile && profile.api === 'openai' && profile.model) {
			// Check if this is a model that needs special parameters
			const needsSpecialParams = profile.model.startsWith('o1') ||
				profile.model.startsWith('o3') ||
				profile.model.startsWith('o4') ||
				profile.model.startsWith('gpt-5');

			if (needsSpecialParams) {
				debug(`Using special parameters for model ${profile.model}`);
				// These models require max_completion_tokens instead of max_tokens
				// and only support temperature=1
				return {
					max_tokens: undefined,  // Remove max_tokens from the payload
					max_completion_tokens: maxTokens,
					temperature: 1,  // Override to default temperature
					top_p: undefined,  // Remove top_p as it may not be supported
					frequency_penalty: undefined,  // Remove frequency_penalty
					presence_penalty: undefined  // Remove presence_penalty
				};
			}
		}
	} catch (error) {
		debug('Error building override payload:', error);
	}

	// Default: let ConnectionManagerRequestService handle it normally
	return {};
}

function getConnectionManagerProfiles() {
	return Array.isArray(extension_settings?.connectionManager?.profiles)
		? extension_settings.connectionManager.profiles
		: [];
}

export function isValidConnectionProfileId(profileId) {
	return typeof profileId === 'string'
		&& profileId.length > 0
		&& getConnectionManagerProfiles().some(profile => profile.id === profileId);
}

export function resolveConnectionProfileId(...profileIds) {
	for (const profileId of profileIds) {
		if (isValidConnectionProfileId(profileId)) {
			return profileId;
		}
	}

	const selectedProfile = extension_settings?.connectionManager?.selectedProfile;
	if (isValidConnectionProfileId(selectedProfile)) {
		return selectedProfile;
	}

	return null;
}

function bookForChar(characterId) {
	debug('getting books for character', characterId);
	let char_data, char_file;
	if (characterId.endsWith('png')) {
		char_data = getContext().characters.find((e) => e.avatar === characterId);
		char_file = getCharaFilename(null, { 'manualAvatarKey': characterId });
	}
	else {
		char_data = getContext().characters[characterId];
		char_file = getCharaFilename(characterId);
	}
	if (char_file in settings.book_assignments) {
		return settings.book_assignments[char_file];
	}
	return "";
}

// Initialize the timeline macro
export function initTimelineMacro() {
	MacrosParser.registerMacro('timeline', () => {
		if (!timelineData || timelineData.length === 0) return '[]';

		// Return structured JSON format
		const jsonTimeline = timelineData.map((chapter, index) => {
			const range = getChapterEffectiveRangeByIndex(index);
			return {
				chapter_id: index + 1,
				message_range: {
					start: range?.startMsgId ?? 0,
					end: range?.endMsgId ?? chapter.endMsgId
				},
				summary: chapter.summary
			};
		});

		// Return as JSON string (MacrosParser will handle the stringification)
		return jsonTimeline;
	}, 'A timeline of summarized chapters from the chat in JSON format');

	// Register the chapter macro - returns all chapter contents with headers
	MacrosParser.registerMacro('chapter', async () => {
		if (!timelineData || timelineData.length === 0) return '';

		const chat = getContext().chat;
		const chaptersContent = [];

		for (let i = 0; i < timelineData.length; i++) {
			const chapter = timelineData[i];
			const chapterHistory = await getChapterHistory(i + 1);
			const range = getChapterEffectiveRangeByIndex(i);

			if (chapterHistory) {
				const chapterContent = chapterHistory.map((it) => `${it.name}: ${it.mes}`).join("\n\n");
				chaptersContent.push(`Chapter: ${i + 1} (Messages ${range?.startMsgId ?? 0}-${range?.endMsgId ?? chapter.endMsgId})\n${chapterContent}`);
			}
		}

		return chaptersContent.join("\n\n");
	}, 'All chapter contents with headers in order');

	// Register the chapterSummary macro - returns all chapter summaries with headers
	MacrosParser.registerMacro('chapterSummary', () => {
		if (!timelineData || timelineData.length === 0) return '';

		const summaries = timelineData.map((chapter, index) => {
			return `Chapter ${index + 1} Summary: ${chapter.summary}`;
		});

		return summaries.join("\n\n");
	}, 'All chapter summaries with headers in order');

	// Register chapterHistory macro - returns visible chat history as a JSON array of { id, name, role, text }
	MacrosParser.registerMacro('chapterHistory', () => {
		const context = getContext();
		const chat = Array.isArray(context.chat) ? context.chat : [];
		if (!chat.length) return [];
		const items = chat
			.map((m, idx) => ({ m, idx }))
			.filter(({ m }) => !m?.is_system)
			.map(({ m, idx }) => ({
				id: idx,
				name: String(m?.name || (m?.is_user ? context.name1 : context.name2) || ''),
				role: m?.is_user ? 'user' : 'assistant',
				text: String(m?.mes || ''),
			}));
		return items; // Macros engine will stringify this array
	}, 'Visible chat history as JSON array of { id, name, role, text }');

	MacrosParser.registerMacro('timelineResponses', () => {
		if (!Array.isArray(timelineFillResults) || timelineFillResults.length === 0) {
			return [];
		}
		// For agentic mode, return just the plaintext response
		if (timelineFillResults.length === 1 && timelineFillResults[0].mode === 'agentic') {
			return timelineFillResults[0].response || '';
		}
		// For static mode, return the full JSON array
		return timelineFillResults;
	}, 'Latest timeline fill query results - plaintext for agentic mode, JSON array for static mode');

	// Register currentChat macro - returns the chat content captured at start of agentic timeline fill session
	MacrosParser.registerMacro('currentChat', () => {
		const content = getCurrentChatContent();
		if (!content) return '';
		return content;
	}, 'Chat content captured at start of agentic timeline fill session (only available during agentic mode)');

	// Register lastMessageId macro - returns the ID of the most recent message
	MacrosParser.registerMacro('lastMessageId', () => {
		const context = getContext();
		const chat = context.chat || [];
		return Math.max(0, chat.length - 1);
	}, 'The ID of the most recent message in the chat');

	// Register firstIncludedMessageId macro - returns the ID of the first message after the last chapter end
	MacrosParser.registerMacro('firstIncludedMessageId', () => {
		const context = getContext();
		const chat = context.chat || [];
		if (!chat.length) return 0;

		// Find the last chapter end marker
		let lastChapterEnd = -1;
		for (let i = chat.length - 1; i >= 0; i--) {
			if (chat[i].extra?.rmr_chapter) {
				lastChapterEnd = i;
				break;
			}
		}

		// Return the message after the last chapter end, or 0 if no chapters
		return lastChapterEnd >= 0 ? lastChapterEnd + 1 : 0;
	}, 'The ID of the first message in the current chapter (after the last chapter end)');
}

// Extension prompt injection key
const TIMELINE_INJECT_KEY = 'TIMELINE_MEMORY_INJECT';

/**
 * Check if timeline injection should be active
 * Returns false during internal generations (queries), or agentic timeline fill
 * @returns {boolean}
 */
function shouldInjectTimeline() {
	// Don't inject during internal extension generations
	if (isInternalGeneration) {
		debug('Timeline injection skipped: internal generation in progress');
		return false;
	}

	// Don't inject during agentic timeline fill mode
	if (isAgenticTimelineFillActive()) {
		debug('Timeline injection skipped: agentic timeline fill active');
		return false;
	}

	return true;
}

/**
 * Update the timeline injection prompt
 * Called when settings change or timeline data is updated
 */
export function updateTimelineInjection() {
	// Clear injection if disabled
	if (!settings.inject_enabled) {
		setExtensionPrompt(TIMELINE_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
		debug('Timeline injection disabled');
		return;
	}

	// Clear injection during agentic timeline fill mode
	if (isAgenticTimelineFillActive()) {
		setExtensionPrompt(TIMELINE_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
		debug('Timeline injection cleared: agentic timeline fill active');
		return;
	}

	const context = getContext();

	// Build the injection prompt by evaluating macros
	let prompt = settings.inject_prompt || '';

	// Replace timeline-specific macros
	const timelineContext = evaluateMacros('{{timeline}}', {});
	const timelineResponsesContext = evaluateMacros('{{timelineResponses}}', {});
	const lastMessageId = evaluateMacros('{{lastMessageId}}', {});
	const firstIncludedMessageId = evaluateMacros('{{firstIncludedMessageId}}', {});

	// Convert to strings if they're arrays/objects
	const timelineStr = typeof timelineContext === 'string' ? timelineContext : JSON.stringify(timelineContext, null, 2);
	const timelineResponsesStr = typeof timelineResponsesContext === 'string' ? timelineResponsesContext : JSON.stringify(timelineResponsesContext, null, 2);

	prompt = prompt.replace(/{{timeline}}/gi, timelineStr);
	prompt = prompt.replace(/{{timelineResponses}}/gi, timelineResponsesStr);
	prompt = prompt.replace(/{{lastMessageId}}/gi, String(lastMessageId));
	prompt = prompt.replace(/{{firstIncludedMessageId}}/gi, String(firstIncludedMessageId));

	// Substitute standard params like {{char}}, {{user}}, etc.
	prompt = context.substituteParams(prompt, context.name1, context.name2);

	// Set the extension prompt
	const depth = settings.inject_depth || 0;
	const role = settings.inject_role ?? extension_prompt_roles.SYSTEM;

	// Use a filter function to prevent injection during internal generations
	const injectionFilter = () => shouldInjectTimeline();

	setExtensionPrompt(
		TIMELINE_INJECT_KEY,
		prompt,
		extension_prompt_types.IN_CHAT,
		depth,
		false, // scan for WI
		role,
		injectionFilter
	);

	debug(`Timeline injection updated: depth=${depth}, role=${role}, length=${prompt.length}`);
}

// Load timeline data from chat metadata
export function loadTimelineData() {
	const context = getContext();
	if (context.chatMetadata?.timeline) {
		timelineData = context.chatMetadata.timeline;
	} else {
		timelineData = [];
	}
	// Also load timeline fill results from metadata
	if (Array.isArray(context.chatMetadata?.timelineFillResults)) {
		timelineFillResults = context.chatMetadata.timelineFillResults;
	} else {
		timelineFillResults = [];
	}
	// Update injection prompt with new data
	updateTimelineInjection();
}

// Save timeline data to chat metadata
function saveTimelineData() {
	const context = getContext();
	if (!context.chatMetadata) {
		context.chatMetadata = {};
	}
	context.chatMetadata.timeline = timelineData;
	context.saveMetadata();

	// Refresh the summaries list in the settings panel
	refreshSummariesList();

	// Update injection prompt with new data
	updateTimelineInjection();
}

const PENDING_CHAPTER_KEY = 'fillTheTimePendingChapter';

function getPendingChapterCheckpoint() {
	const context = getContext();
	const pending = context.chatMetadata?.[PENDING_CHAPTER_KEY];
	return pending && typeof pending === 'object' ? pending : null;
}

function savePendingChapterCheckpoint(checkpoint) {
	const context = getContext();
	if (!context.chatMetadata) {
		context.chatMetadata = {};
	}
	context.chatMetadata[PENDING_CHAPTER_KEY] = {
		...checkpoint,
		updatedAt: new Date().toISOString(),
	};
	context.saveMetadata();
}

function clearPendingChapterCheckpoint(targetMessageId = null) {
	const context = getContext();
	if (!context.chatMetadata?.[PENDING_CHAPTER_KEY]) return;
	if (targetMessageId !== null && context.chatMetadata[PENDING_CHAPTER_KEY]?.targetMessageId !== targetMessageId) return;
	delete context.chatMetadata[PENDING_CHAPTER_KEY];
	context.saveMetadata();
}

function getChapterCheckpointKey({ startMsgId, targetMessageId, chunkCount }) {
	return `${startMsgId}:${targetMessageId}:${chunkCount}`;
}

function matchesPendingChapterCheckpoint(pendingCheckpoint, { startMsgId, targetMessageId }) {
	if (!pendingCheckpoint || typeof pendingCheckpoint !== 'object') {
		return false;
	}

	if (Number(pendingCheckpoint.startMsgId) === Number(startMsgId)
		&& Number(pendingCheckpoint.targetMessageId) === Number(targetMessageId)) {
		return true;
	}

	const legacyKeyPrefix = `${startMsgId}:${targetMessageId}:`;
	return typeof pendingCheckpoint.checkpointKey === 'string'
		&& pendingCheckpoint.checkpointKey.startsWith(legacyKeyPrefix);
}

// Helper function to refresh the summaries list UI
async function refreshSummariesList() {
	try {
		const { renderSummariesList } = await import('./settings.js');
		renderSummariesList();
	} catch (err) {
		// Settings module might not be fully loaded yet, ignore
		debug('Could not refresh summaries list:', err.message);
	}
}

// Add a chapter to the timeline
function addChapterToTimeline(summary, startMsgId, endMsgId) {
	const newChapter = {
		summary: summary,
		startMsgId: startMsgId,
		endMsgId: endMsgId
	};

	timelineData.push(newChapter);
	saveTimelineData();
	debug('Added chapter to timeline:', newChapter);
}

export function createManualChapter(startMsgId, endMsgId, summary = '') {
	const context = getContext();
	const chat = context.chat || [];
	const start = Number(startMsgId);
	const end = Number(endMsgId);

	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		return { ok: false, message: 'Start and end message IDs must be whole numbers.' };
	}
	if (start < 0 || end < 0 || start >= chat.length || end >= chat.length) {
		return { ok: false, message: `Message range must be within 0-${Math.max(chat.length - 1, 0)}.` };
	}
	if (end < start) {
		return { ok: false, message: 'End message ID must be greater than or equal to start message ID.' };
	}
	if (timelineData.some(chapter => chapter.endMsgId === end)) {
		return { ok: false, message: `Message ${end} is already marked as a chapter end.` };
	}

	const overlappingChapter = timelineData.find((chapter) => {
		const chapterIndex = timelineData.indexOf(chapter);
		const chapterRange = getChapterEffectiveRangeByIndex(chapterIndex);
		const chapterStart = chapterRange?.startMsgId ?? 0;
		const chapterEnd = chapter.endMsgId;
		return start <= chapterEnd && end >= chapterStart;
	});

	if (overlappingChapter) {
		const chapterNumber = timelineData.indexOf(overlappingChapter) + 1;
		const chapterStart = getChapterEffectiveRangeByIndex(chapterNumber - 1)?.startMsgId ?? 0;
		return {
			ok: false,
			message: `Range overlaps Chapter ${chapterNumber} (${chapterStart}-${overlappingChapter.endMsgId}).`,
		};
	}

	const storedStartBoundary = start === 0 ? 0 : start - 1;
	timelineData.push({
		summary: String(summary || ''),
		startMsgId: storedStartBoundary,
		endMsgId: end,
		manual: true,
	});
	timelineData.sort((a, b) => a.endMsgId - b.endMsgId);

	chat[end].extra = chat[end].extra || {};
	chat[end].extra.rmr_chapter = true;
	context.saveChat();
	saveTimelineData();

	const highlightEl = $(`.mes[mesid="${end}"] .rmr-button.fa-circle-stop`);
	if (highlightEl.length > 0) {
		toggleChapterHighlight(highlightEl, end);
	}

	const chapterNumber = timelineData.findIndex(chapter => chapter.endMsgId === end) + 1;
	return {
		ok: true,
		chapterNumber,
		startMsgId: start,
		endMsgId: end,
		message: `Created Chapter ${chapterNumber} (${start}-${end}).`,
	};
}

// Migrate old timeline entries - timestamp removal, plaintext format conversion, and scene->chapter key migration
export function migrateTimelineData() {
	let migrated = 0;
	let convertedFromPlaintext = false;
	let hadTimestamps = false;
	let convertedSceneToChapter = false;

	if (!timelineData || timelineData.length === 0) {
		return { migrated: 0, hadTimestamps: false, convertedFromPlaintext: false, convertedSceneToChapter: false };
	}

	// Check if we need to convert from plaintext format
	// Old plaintext format detection: if timeline is a string instead of array
	const context = getContext();
	if (context.chatMetadata?.timeline && typeof context.chatMetadata.timeline === 'string') {
		// Parse old plaintext format: "Scene X (Messages Y-Z): Summary" or "Chapter X (Messages Y-Z): Summary"
		const plaintextTimeline = context.chatMetadata.timeline;
		const chapterRegex = /(?:Scene|Chapter)\s+(\d+)\s+\(Messages\s+(\d+)-(\d+)\):\s+(.+?)(?=\n\n(?:Scene|Chapter)\s+\d+|$)/gs;
		const newTimeline = [];
		let match;

		while ((match = chapterRegex.exec(plaintextTimeline)) !== null) {
			newTimeline.push({
				summary: match[4].trim(),
				startMsgId: parseInt(match[2]),
				endMsgId: parseInt(match[3])
			});
			migrated++;
		}

		if (newTimeline.length > 0) {
			timelineData = newTimeline;
			convertedFromPlaintext = true;
			debug(`Converted ${migrated} chapters from plaintext format to structured format`);
		}
	}

	// Check if any entries have timestamps (for backward compatibility)
	const hasTimestamps = timelineData.some(chapter => 'timestamp' in chapter);

	if (hasTimestamps) {
		hadTimestamps = true;
		// Remove timestamp from each chapter
		timelineData = timelineData.map(chapter => {
			if ('timestamp' in chapter) {
				if (!convertedFromPlaintext) migrated++;
				// Create new object without timestamp
				const { timestamp, ...chapterWithoutTimestamp } = chapter;
				return chapterWithoutTimestamp;
			}
			return chapter;
		});
	}

	// Also migrate chat metadata that may have scene markers
	if (context.chat && context.chat.length > 0) {
		let chatUpdated = false;
		context.chat.forEach(message => {
			if (message.extra?.rmr_scene) {
				delete message.extra.rmr_scene;
				message.extra.rmr_chapter = true;
				chatUpdated = true;
				convertedSceneToChapter = true;
			}
		});
		if (chatUpdated) {
			context.saveChat();
			debug('Migrated scene markers to chapter markers in chat');
		}
	}

	// Save the updated timeline if we made any changes
	if (convertedFromPlaintext || hasTimestamps || convertedSceneToChapter) {
		saveTimelineData();
		debug(`Migration complete: ${migrated} entries updated`);
	}

	return { migrated, hadTimestamps, convertedFromPlaintext, convertedSceneToChapter };
}

// Remove a chapter from the timeline
export function removeChapterFromTimeline(endMsgId) {
	// Find the chapter with this endMsgId
	const chapterIndex = timelineData.findIndex(chapter => chapter.endMsgId === endMsgId);

	if (chapterIndex === -1) {
		debug('No chapter found with endMsgId:', endMsgId);
		return false;
	}

	// Get the chapter before removing it
	const removedChapter = timelineData[chapterIndex];

	// If hide_chapter is enabled, unhide the messages from this chapter
	if (settings.hide_chapter && !removedChapter.manual) {
		const chat = getContext().chat;
		const removedRange = getChapterEffectiveRangeByIndex(chapterIndex);
		const startIdx = removedRange?.startMsgId ?? 0;

		// Unhide all messages in the chapter range
		for (let i = startIdx; i <= removedChapter.endMsgId; i++) {
			if (chat[i] && chat[i].is_system === true) {
				// Unhide the message
				chat[i].is_system = false;

				// Also update the visible message element
				const mes_elem = $(`.mes[mesid="${i}"]`);
				if (mes_elem.length) {
					mes_elem.attr('is_system', 'false');
				}
			}
		}

		getContext().saveChat();
	}

	// Remove the chapter from timeline
	timelineData.splice(chapterIndex, 1);
	saveTimelineData();
	debug('Removed chapter from timeline:', removedChapter);

	return removedChapter;
}

// Get a specific chapter's summary
export function getChapterSummary(chapterNumber) {
	if (chapterNumber < 1 || chapterNumber > timelineData.length) {
		return null;
	}
	return timelineData[chapterNumber - 1].summary;
}

// Update a specific chapter's summary
export function updateChapterSummary(chapterNumber, newSummary) {
	if (chapterNumber < 1 || chapterNumber > timelineData.length) {
		return false;
	}
	timelineData[chapterNumber - 1].summary = newSummary;
	saveTimelineData();
	debug('Updated chapter summary:', chapterNumber, newSummary);
	return true;
}

// Get a specific chapter's full chat history
export async function getChapterHistory(chapterNumber) {
	if (chapterNumber < 1 || chapterNumber > timelineData.length) {
		return null;
	}

	const chapter = timelineData[chapterNumber - 1];
	const chat = getContext().chat;
	const range = getChapterEffectiveRangeByIndex(chapterNumber - 1);

	const actualStartIdx = range?.startMsgId ?? 0;

	debug(`Getting chapter ${chapterNumber} history:`, {
		startMsgId: actualStartIdx,
		endMsgId: chapter.endMsgId,
		actualStartIdx: actualStartIdx,
		totalMessages: chapter.endMsgId - actualStartIdx + 1
	});

	// Get messages from the chapter
	const chapterMessages = chat.slice(actualStartIdx, chapter.endMsgId + 1);

	// Process messages for regex/hidden
	const processedMessages = await Promise.all(chapterMessages.map(async (message, index) => {
		let placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
		let options = { isPrompt: true, depth: 0 };
		let mes_text = message.is_system ? message.mes : getRegexedString(message.mes, placement, options);
		return {
			...message,
			mes: mes_text
		};
	}));

	// Don't filter out system messages here - they might be hidden chapter messages!
	// The chapter query needs to see ALL messages in the chapter, including those hidden by the extension
	return processedMessages;
}

export async function getChapterTokenCount(chapterNumber) {
	if (chapterNumber < 1 || chapterNumber > timelineData.length) {
		return 0;
	}
	const chapter = timelineData[chapterNumber - 1];
	const chapterText = String(chapter?.summary || '').trim();
	if (!chapterText.length) {
		return 0;
	}
	const getTokenCount = getContext().getTokenCountAsync;
	if (typeof getTokenCount === 'function') {
		const splitText = (text, maxChars = 12000) => {
			const normalized = String(text || '');
			if (!normalized) return [];
			if (normalized.length <= maxChars) return [normalized];
			const parts = [];
			let start = 0;
			while (start < normalized.length) {
				let end = Math.min(normalized.length, start + maxChars);
				if (end < normalized.length) {
					const newlineBreak = normalized.lastIndexOf('\n', end);
					const sentenceBreak = normalized.lastIndexOf('. ', end);
					const spaceBreak = normalized.lastIndexOf(' ', end);
					const bestBreak = Math.max(newlineBreak, sentenceBreak, spaceBreak);
					if (bestBreak > start + Math.floor(maxChars * 0.6)) {
						end = bestBreak + 1;
					}
				}
				parts.push(normalized.slice(start, end));
				start = end;
			}
			return parts.filter(Boolean);
		};

		let total = 0;
		for (const part of splitText(chapterText)) {
			try {
				total += await getTokenCount(part);
			} catch (_) {
				total += Math.ceil(part.length / 4);
			}
		}
		return total;
	}
	return Math.ceil(chapterText.length / 4);
}

async function processMessageSlice(mes_id, count = 0, start = 0) {
	const chat = getContext().chat;
	const length = chat.length;

	// slice to just the history from this message
	let message_history = chat.slice(start, mes_id + 1);

	// process for regex/hidden
	message_history = await Promise.all(message_history.map(async (message, index) => {
		let placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
		let options = { isPrompt: true, depth: (length - (start + index) - 1) };
		// no point in running the regexing on hidden messages
		let mes_text = message.is_system ? message.mes : getRegexedString(message.mes, placement, options);
		return {
			...message,
			mes: mes_text,
			index: start + index,
		};
	}));

	// filter out hidden messages
	message_history = message_history.filter((it) => { return !it.is_system });
	if (count > 0) {
		count++;
		if (message_history.length > count) {
			// slice it again
			message_history = message_history.slice(-1 * count);
		}
	}
	return message_history;
}

async function swapProfile(profileId = null) {
	let swapped = false;
	if (!extension_settings.connectionManager?.profiles || !extension_settings.connectionManager?.selectedProfile) {
		debug('Connection Manager extension not available');
		return false;
	}
	const current = extension_settings.connectionManager.selectedProfile;
	const target_id = resolveConnectionProfileId(commandArgs?.profile, profileId, settings.profile);
	if (!target_id) {
		oopsToast("No valid connection profile available; using current profile.");
		return false;
	}
	if (current != target_id) {
		// we have to swap
		debug('swapping profile');
		swapped = current;
		$('#connection_profiles').val(target_id);
		document.getElementById('connection_profiles').dispatchEvent(new Event('change'));
		await new Promise((resolve) => getContext().eventSource.once(getContext().event_types.CONNECTION_PROFILE_LOADED, resolve));
	}
	return swapped;
}

async function genSummaryWithSlash(history, id = 0, { resummarizeChapterNumber = null } = {}) {
	// Initialize commandArgs if not set
	if (!commandArgs) {
		commandArgs = {};
	}

	// Mark as internal generation to prevent timeline injection
	isInternalGeneration = true;

	try {
		let this_delay = delay_ms() - (Date.now() - last_gen_timestamp);
		debug('delaying', this_delay, "out of", delay_ms());
		if (this_delay > 0) {
			await new Promise(resolve => setTimeout(resolve, this_delay));
		}
		last_gen_timestamp = Date.now();

		if (id > 0) {
			infoToast("Generating summary #" + id + "....");
		}
		// Get timeline context for macro replacement
		// If resummarizing a chapter, only include chapters before the target (the AI shouldn't know about future events)
		let timelineContext;
		if (resummarizeChapterNumber !== null && timelineData && timelineData.length > 0) {
			const chapterIndex = resummarizeChapterNumber - 1;
			// Only include chapters before the target chapter
			const modifiedTimeline = timelineData.slice(0, chapterIndex).map((chapter, index) => {
				const range = getChapterEffectiveRangeByIndex(index);
				return {
					chapter_id: index + 1,
					message_range: {
						start: range?.startMsgId ?? 0,
						end: range?.endMsgId ?? chapter.endMsgId
					},
					summary: chapter.summary
				};
			});
			// Stringify to match the format evaluateMacros would produce
			timelineContext = JSON.stringify(modifiedTimeline);
		} else {
			timelineContext = evaluateMacros('{{timeline}}', {});
		}

		if (typeof timelineContext !== 'string') {
			timelineContext = JSON.stringify(timelineContext, null, 2);
		}

		const prompt_text = settings.memory_prompt_template.replace('{{content}}', history.trim());

		// Replace {{timeline}} macro in prompt
		let finalPrompt = prompt_text.replace(/{{timeline}}/gi, timelineContext);

		// Also substitute standard params like {{char}}, {{user}}, etc.
		const context = getContext();
		finalPrompt = context.substituteParams(finalPrompt, context.name1, context.name2);

		// Process system prompt with macro replacements
		let systemPrompt = '';
		if (settings.memory_system_prompt && settings.memory_system_prompt.trim()) {
			systemPrompt = settings.memory_system_prompt.replace('{{content}}', history.trim());
			// Replace {{timeline}} macro in system prompt
			systemPrompt = systemPrompt.replace(/{{timeline}}/gi, timelineContext);
			// Also substitute standard params like {{char}}, {{user}}, etc.
			systemPrompt = context.substituteParams(systemPrompt, context.name1, context.name2);
		}

		// Determine which profile to use
		const profileId = resolveConnectionProfileId(commandArgs?.profile, settings.profile);

		// Use ConnectionManagerRequestService if a profile is specified
		if (profileId && ConnectionManagerRequestService) {
			debug(`Using ConnectionManagerRequestService with profile: ${profileId}`);

			// Build messages array for the request
			const messages = [];
			if (systemPrompt) {
				messages.push({ role: 'system', content: systemPrompt });
			}
			messages.push({ role: 'user', content: finalPrompt });

			// Get max tokens for the profile
			const maxTokens = await getMaxTokensForProfile(profileId);
			debug(`Using max tokens: ${maxTokens} for profile: ${profileId}`);

			// Build override payload for special cases like OpenAI o1 models
			const overridePayload = buildOverridePayload(profileId, maxTokens);

			// Get the reasoning effort value for this profile
			const reasoningEffort = getReasoningEffort(profileId);

			// Add reasoning_effort to override payload if it exists
			if (reasoningEffort !== undefined) {
				overridePayload.reasoning_effort = reasoningEffort;
			}

			// z.ai requires an explicit flag to return reasoning content
			const includeReasoning = getIncludeReasoning(profileId);
			if (includeReasoning !== undefined) {
				overridePayload.include_reasoning = includeReasoning;
			}

			// Use ConnectionManagerRequestService to send the request
			const result = await sendReliableApiRequest(
				profileId,              // profileId
				messages,               // prompt (as messages array)
				maxTokens,              // maxTokens
				{                       // custom options
					includePreset: true,  // Include generation preset from profile
					includeInstruct: true, // Include instruct settings
					stream: false         // Don't stream the response
				},
				overridePayload         // overridePayload with correct parameter names
			);

			// Extract content from response - parse reasoning if needed
			const content = result?.content || result || '';
			const parsed_result = getContext().parseReasoningFromString(content);
			const final_content = parsed_result ? parsed_result.content : content;

			debug('Successfully used ConnectionManagerRequestService for summary');
			return final_content;
		}

		// No profile specified and no fallback available
		// No profile specified and no fallback available
		// FALLBACK: Use standard SillyTavern generateQuietPrompt
		const fallbackPrompt = systemPrompt ? `${systemPrompt}\n\n${finalPrompt}` : finalPrompt;
		try {
			const { generateQuietPrompt } = await import("../../../../../script.js");
			const result = await generateQuietPrompt({ quietPrompt: fallbackPrompt });
			debug('Successfully used standard generateQuietPrompt for summary');
			return result;
		} catch (e) {
			debug('Fallback generation failed:', e);
			throw new Error('API connection failed. No connection profile specified and standard generation is unavailable: ' + e.message);
		}
	} finally {
		// Always reset the flag when done
		isInternalGeneration = false;
	}
}

async function generateMemory(message) {
	const mes_id = Number(message.attr('mesid'));

	const memory_history = await processMessageSlice(mes_id, settings.memory_span);
	debug('memory history', memory_history);
	const memory_context = memory_history.map((it) => `${it.name}: ${it.mes}`).join("\n\n");
	return await genSummaryWithSlash(memory_context);
}

async function reasoningParser(str, profileId, { strict = true } = {}) {
	const profiles = extension_settings?.connectionManager?.profiles || [];
	const profile = profiles.find(p => p.id === profileId);

	if (!profile) {
		return { reasoning: '', content: str };
	}

	const templateName = profile['reasoning-template'];
	console.log(templateName);
	const template = reasoning_templates.find(t => t.name === templateName);
	if (template) {
		const regex = new RegExp(`${(strict ? '^\\s*?' : '')}${escapeRegex(template.prefix)}(.*?)${escapeRegex(template.suffix)}`, 's');
		let didReplace = false;
		let reasoning = '';
		let content = String(str).replace(regex, (_match, captureGroup) => {
			didReplace = true;
			reasoning = captureGroup;
			return '';
		});

		if (didReplace) {
			reasoning = trimSpaces(reasoning);
			content = trimSpaces(content);
		}

		return { reasoning, content };
		//const parser = new ReasoningParser(template.prefix, template.suffix, template.separator);
		// const parsed = parser.parse(content);
	}
}

function stripCodeFences(text) {
	if (typeof text !== 'string') {
		return '';
	}
	let cleaned = text.trim();
	const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
	if (fenceMatch) {
		cleaned = fenceMatch[1].trim();
	}
	return cleaned;
}

function extractJsonArrayFromText(text) {
	if (!text) {
		return null;
	}
	const cleaned = stripCodeFences(text);
	const firstBracket = cleaned.indexOf('[');
	const lastBracket = cleaned.lastIndexOf(']');

	if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
		const candidate = cleaned.slice(firstBracket, lastBracket + 1);
		try {
			return JSON.parse(candidate);
		} catch (error) {
			debug('Failed to parse candidate JSON array:', error);
		}
	}

	try {
		return JSON.parse(cleaned);
	} catch (error) {
		debug('Failed to parse full response as JSON:', error);
		return null;
	}
}

function coerceChapterNumber(value) {
	const num = Number(value);
	if (!Number.isFinite(num)) {
		return null;
	}
	const int = Math.floor(num);
	return int >= 1 ? int : null;
}

function uniqueSortedChapters(chapters) {
	return Array.from(new Set(chapters.filter((num) => typeof num === 'number')))
		.sort((a, b) => a - b);
}

function chaptersAreContiguous(chapters) {
	if (chapters.length <= 1) {
		return true;
	}
	for (let i = 1; i < chapters.length; i++) {
		if (chapters[i] !== chapters[i - 1] + 1) {
			return false;
		}
	}
	return true;
}

function normalizeTimelineFillItem(item, index) {
	const errors = [];
	if (!item || typeof item !== 'object') {
		errors.push(`Item at index ${index} is not an object.`);
		return { errors };
	}

	const query = typeof item.query === 'string' ? item.query.trim() : '';
	if (!query) {
		errors.push(`Item ${index} is missing a valid "query" string.`);
	}

	const collectedChapters = [];
	const chapterArrays = [
		item.chapters,
		item.chapterNumbers,
		item.chapter_ids,
		Array.isArray(item.chapterRange) && item.chapterRange.length === 2 ? item.chapterRange : null,
	];

	for (const candidate of chapterArrays) {
		if (Array.isArray(candidate)) {
			for (const value of candidate) {
				const num = coerceChapterNumber(value);
				if (num !== null) {
					collectedChapters.push(num);
				}
			}
		}
	}

	const singleChapterCandidates = [
		item.chapter,
		item.chapterNumber,
		item.chapter_id,
	];

	for (const candidate of singleChapterCandidates) {
		const num = coerceChapterNumber(candidate);
		if (num !== null) {
			collectedChapters.push(num);
		}
	}

	let rangeStart = coerceChapterNumber(
		item.startChapter ?? item.chapterStart ?? item.range?.start ?? item.range?.from,
	);
	let rangeEnd = coerceChapterNumber(
		item.endChapter ?? item.chapterEnd ?? item.range?.end ?? item.range?.to,
	);

	if (Array.isArray(item.range) && item.range.length === 2) {
		const [a, b] = item.range;
		const rangeValues = [coerceChapterNumber(a), coerceChapterNumber(b)];
		if (rangeValues[0] !== null && rangeValues[1] !== null) {
			rangeStart = rangeValues[0];
			rangeEnd = rangeValues[1];
		}
	}

	if (rangeStart !== null && rangeEnd !== null) {
		if (rangeEnd < rangeStart) {
			[rangeStart, rangeEnd] = [rangeEnd, rangeStart];
		}
		for (let chapter = rangeStart; chapter <= rangeEnd; chapter++) {
			collectedChapters.push(chapter);
		}
	}

	const chapters = uniqueSortedChapters(collectedChapters);
	if (!chapters.length) {
		errors.push(`Item ${index} must include either "chapters" array, a single "chapter", or a "startChapter"/"endChapter" range.`);
	}

	return {
		errors,
		item: {
			query,
			chapters,
			startChapter: chapters.length ? chapters[0] : null,
			endChapter: chapters.length ? chapters[chapters.length - 1] : null,
		},
	};
}

function validateTimelineFillItems(rawItems) {
	if (!Array.isArray(rawItems)) {
		throw new Error('Timeline fill response must be a JSON array.');
	}

	const normalized = [];
	const errors = [];

	rawItems.forEach((entry, index) => {
		const result = normalizeTimelineFillItem(entry, index);
		if (result.errors.length) {
			errors.push(...result.errors);
			return;
		}
		normalized.push(result.item);
	});

	if (errors.length) {
		throw new Error(errors.join('\n'));
	}

	return normalized;
}

export async function runTimelineFill({ profileOverride, quiet = true } = {}) {
	// Create a backup before any operations
	await createChatBackup('timeline fill');

	// Show loading screen if enabled (no abort callback for static timeline fill)
	if (settings.loading_screen_enabled) {
		showLoadingScreen('timeline-fill');
	}

	loadTimelineData();

	const profileId = resolveConnectionProfileId(profileOverride, settings.timeline_fill_profile, settings.profile);
	if (!profileId) {
		throw new Error('Timeline fill profile is not configured and no active Connection Manager profile is available.');
	}

	// Mark as internal generation to prevent timeline injection
	isInternalGeneration = true;

	const context = getContext();
	const timelineMacroResult = evaluateMacros('{{timeline}}', {}) ?? [];
	const historyMacroResult = evaluateMacros('{{chapterHistory}}', {}) ?? [];

	const timelineContext = typeof timelineMacroResult === 'string'
		? timelineMacroResult
		: JSON.stringify(timelineMacroResult, null, 2);

	const historyContext = typeof historyMacroResult === 'string'
		? historyMacroResult
		: JSON.stringify(historyMacroResult, null, 2);

	let userPrompt = settings.timeline_fill_prompt_template || '';
	userPrompt = userPrompt.replace(/{{timeline}}/gi, timelineContext);
	userPrompt = userPrompt.replace(/{{chapterHistory}}/gi, historyContext);
	userPrompt = context.substituteParams(userPrompt, context.name1, context.name2);

	let systemPrompt = settings.timeline_fill_system_prompt || '';
	if (systemPrompt) {
		systemPrompt = systemPrompt.replace(/{{timeline}}/gi, timelineContext);
		systemPrompt = systemPrompt.replace(/{{chapterHistory}}/gi, historyContext);
		systemPrompt = context.substituteParams(systemPrompt, context.name1, context.name2);
	}

	const messages = [];
	if (systemPrompt) {
		messages.push({ role: 'system', content: systemPrompt });
	}
	messages.push({ role: 'user', content: userPrompt });

	try {
		debug('Timeline fill request messages:', messages);

		const maxTokens = await getMaxTokensForProfile(profileId);
		const overridePayload = buildOverridePayload(profileId, maxTokens);
		const reasoningEffort = getReasoningEffort(profileId);
		if (reasoningEffort !== undefined) {
			overridePayload.reasoning_effort = reasoningEffort;
		}
		const includeReasoning = getIncludeReasoning(profileId);
		if (includeReasoning !== undefined) {
			overridePayload.include_reasoning = includeReasoning;
		}

		const result = await sendReliableApiRequest(
			profileId,
			messages,
			maxTokens,
			{
				includePreset: true,
				includeInstruct: true,
				stream: false,
			},
			overridePayload,
		);

		const rawContent = result?.content || result || '';
		const parsedReasoning = await reasoningParser(rawContent, profileId, { strict: false });
		const content = parsedReasoning ? parsedReasoning.content : rawContent;

		debug('Timeline fill raw response:', content);

		const parsed = extractJsonArrayFromText(content);
		let items = [];

		if (Array.isArray(parsed)) {
			items = parsed;
		} else if (parsed?.queries && Array.isArray(parsed.queries)) {
			items = parsed.queries;
		} else if (parsed?.timelineQueries && Array.isArray(parsed.timelineQueries)) {
			items = parsed.timelineQueries;
		} else {
			throw new Error('Timeline fill response did not include a JSON array of queries.');
		}

		const tasks = validateTimelineFillItems(items);
		const aggregatedResults = [];
		const previousCommandArgs = commandArgs;
		commandArgs = { ...(previousCommandArgs || {}), quiet };

		await setTimelineFillResults([]);

		// Count total queries for progress tracking (excluding those that exceed the chapter limit)
		const chapterLimit = settings.query_chapter_limit || 0;
		const queryLimit = settings.timeline_fill_query_limit || 0;
		let totalQueries = 0;
		for (const task of tasks) {
			const { chapters } = task;
			if (!chapters.length) continue;
			const contiguous = chaptersAreContiguous(chapters);
			// Range queries count as 1, non-contiguous chapters count individually
			// Skip range queries that exceed the chapter limit (if limit is set)
			if (contiguous && chapters.length > 1) {
				if (chapterLimit === 0 || chapters.length <= chapterLimit) {
					totalQueries += 1;
				}
			} else {
				totalQueries += chapters.length;
			}
		}

		// Apply query limit if set
		if (queryLimit > 0 && totalQueries > queryLimit) {
			debug(`Timeline fill limiting queries from ${totalQueries} to ${queryLimit}`);
			totalQueries = queryLimit;
		}

		// Switch to querying phase if progress is visible
		if (isProgressVisible()) {
			updateRetrievalProgress({ phase: 'querying', current: 0, total: totalQueries });
		}

		let completedQueries = 0;

		try {
			for (const task of tasks) {
				const { query, chapters } = task;
				if (!chapters.length) {
					continue;
				}

				const contiguous = chaptersAreContiguous(chapters);
				const start = chapters[0];
				const end = chapters[chapters.length - 1];

				if (contiguous && chapters.length > 1) {
					// Skip queries that exceed the chapter limit (if limit is set)
					if (chapterLimit > 0 && chapters.length > chapterLimit) {
						debug(`Timeline fill skipping query: exceeds ${chapterLimit}-chapter limit (${chapters.length} chapters requested)`);
						continue;
					}
					try {
						const response = await queryChapters(start, end, query);
						aggregatedResults.push({
							mode: 'range',
							query,
							chapters,
							startChapter: start,
							endChapter: end,
							response: String(response ?? ''),
						});
					} catch (error) {
						debug('Timeline fill range query failed:', error);
						aggregatedResults.push({
							mode: 'range',
							query,
							chapters,
							startChapter: start,
							endChapter: end,
							response: '',
							error: error?.message || String(error),
						});
					}
					completedQueries++;
					if (isProgressVisible()) {
						updateRetrievalProgress({ current: completedQueries, total: totalQueries });
					}
					// Stop if we've hit the query limit
					if (queryLimit > 0 && completedQueries >= queryLimit) {
						debug(`Timeline fill reached query limit of ${queryLimit}`);
						break;
					}
				} else {
					for (const chapter of chapters) {
						// Stop if we've hit the query limit
						if (queryLimit > 0 && completedQueries >= queryLimit) {
							debug(`Timeline fill reached query limit of ${queryLimit}`);
							break;
						}
						try {
							const response = await queryChapter(chapter, query);
							aggregatedResults.push({
								mode: 'single',
								query,
								chapters: [chapter],
								startChapter: chapter,
								endChapter: chapter,
								response: String(response ?? ''),
							});
						} catch (error) {
							debug('Timeline fill chapter query failed:', error);
							aggregatedResults.push({
								mode: 'single',
								query,
								chapters: [chapter],
								startChapter: chapter,
								endChapter: chapter,
								response: '',
								error: error?.message || String(error),
							});
						}
						completedQueries++;
						if (isProgressVisible()) {
							updateRetrievalProgress({ current: completedQueries, total: totalQueries });
						}
					}
				}
				// Stop outer loop if we've hit the query limit
				if (queryLimit > 0 && completedQueries >= queryLimit) {
					break;
				}
			}

			// Mark as complete
			if (isProgressVisible()) {
				updateRetrievalProgress({ phase: 'complete', current: completedQueries, total: totalQueries, message: 'All queries complete!' });
			}
		} finally {
			commandArgs = previousCommandArgs;
		}

		await setTimelineFillResults(aggregatedResults);
		return aggregatedResults;
	} catch (error) {
		debug('Timeline fill failed:', error);
		throw error;
	} finally {
		// Hide loading screen if it was shown
		hideLoadingScreen();
		// Always reset the flag when done
		isInternalGeneration = false;
	}
}


// Query a chapter with a specific question
export async function queryChapter(chapterNumber, query) {
	// Initialize commandArgs if not set
	if (!commandArgs) {
		commandArgs = {};
	}

	// Mark as internal generation to prevent timeline injection
	isInternalGeneration = true;

	try {
		// Check if timeline has any chapters
		if (!timelineData || timelineData.length === 0) {
			const msg = 'No chapters exist in the timeline yet.';
			errorToast(msg);
			return msg;
		}

		// Check if chapter is within valid range
		if (chapterNumber < 1 || chapterNumber > timelineData.length) {
			const msg = `Chapter ${chapterNumber} does not exist. Valid chapter range is 1-${timelineData.length}.`;
			errorToast(msg);
			return msg;
		}

		const chapterHistory = await getChapterHistory(chapterNumber);
		if (!chapterHistory) {
			const msg = `Chapter ${chapterNumber} not found.`;
			errorToast(msg);
			return msg;
		}

		const chapter = timelineData[chapterNumber - 1];
		debug(`Querying chapter ${chapterNumber}:`, chapter);
		debug(`Chapter history length: ${chapterHistory.length} messages`);

		const timelineContext = evaluateMacros('{{timeline}}', {});
		const timelineStr = typeof timelineContext === 'string' ? timelineContext : JSON.stringify(timelineContext, null, 2);

		// Format the chapter history - this is ALL messages from the chapter
		const chapterContext = chapterHistory.map((it) => `${it.name}: ${it.mes}`).join("\n\n");

		debug(`Chapter context length: ${chapterContext.length} characters`);
		debug(`Timeline context length: ${timelineStr.length} characters`);
		debug(`Query: ${query}`);

		// Build the prompt - for now, use simple string replacement to ensure it works
		let prompt = settings.chapter_query_prompt_template;

		// Replace macros in order - most specific first
		prompt = prompt.replace(/{{timeline}}/gi, timelineStr);
		prompt = prompt.replace(/{{chapter}}/gi, chapterContext);
		// Also replace {{chapterSummary}} with the actual chapter summary
		prompt = prompt.replace(/{{chapterSummary}}/gi, chapter.summary);
		prompt = prompt.replace(/{{query}}/gi, query);

		// Then use substituteParams for any remaining standard macros like {{char}}, {{user}}, etc.
		const context = getContext();
		prompt = context.substituteParams(prompt, context.name1, context.name2);

		// Process system prompt with the same macro replacements
		let systemPrompt = '';
		if (settings.chapter_query_system_prompt && settings.chapter_query_system_prompt.trim()) {
			systemPrompt = settings.chapter_query_system_prompt;
			// Replace the same macros in system prompt
			systemPrompt = systemPrompt.replace(/{{timeline}}/gi, timelineStr);
			systemPrompt = systemPrompt.replace(/{{chapter}}/gi, chapterContext);
			// Also replace {{chapterSummary}} with the actual chapter summary
			systemPrompt = systemPrompt.replace(/{{chapterSummary}}/gi, chapter.summary);
			systemPrompt = systemPrompt.replace(/{{query}}/gi, query);
			// Also substitute standard params
			systemPrompt = context.substituteParams(systemPrompt, context.name1, context.name2);
		}

		debug(`Final prompt length: ${prompt.length} characters`);
		debug(`System prompt length: ${systemPrompt.length} characters`);

		infoToast(`Querying chapter ${chapterNumber}...`);

		const profileId = resolveConnectionProfileId(settings.query_profile, settings.profile);

		// Use ConnectionManagerRequestService if a profile is specified
		if (profileId && ConnectionManagerRequestService) {
			debug(`Using ConnectionManagerRequestService with profile: ${profileId}`);

			// Build messages array for the request
			const messages = [];
			if (systemPrompt) {
				messages.push({ role: 'system', content: systemPrompt });
			}
			messages.push({ role: 'user', content: prompt });

			// Get max tokens for the profile
			const maxTokens = await getMaxTokensForProfile(profileId);
			debug(`Using max tokens: ${maxTokens} for profile: ${profileId}`);

			// Build override payload for special cases like OpenAI o1 models
			const overridePayload = buildOverridePayload(profileId, maxTokens);

			// Get the reasoning effort value for this profile
			const reasoningEffort = getReasoningEffort(profileId);

			// Add reasoning_effort to override payload if it exists
			if (reasoningEffort !== undefined) {
				overridePayload.reasoning_effort = reasoningEffort;
			}
			const includeReasoning = getIncludeReasoning(profileId);
			if (includeReasoning !== undefined) {
				overridePayload.include_reasoning = includeReasoning;
			}

			// Use ConnectionManagerRequestService to send the request
			const result = await sendReliableApiRequest(
				profileId,              // profileId
				messages,                // prompt (as messages array)
				maxTokens,               // maxTokens
				{                        // custom options
					includePreset: true, // Include generation preset from profile
					stream: false        // Don't stream the response
				},
				overridePayload          // overridePayload with correct parameter names
			);

			// Extract content from response - parse reasoning if needed
			const content = result?.content || result || '';
			const parsed_reasoning = await reasoningParser(content, profileId);
			const final_content = parsed_reasoning ? parsed_reasoning.content : content;
			debug('Successfully used ConnectionManagerRequestService for query');
			return final_content;
		}

		// No profile: fallback to standard SillyTavern API
		const fallbackPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
		const { generateQuietPrompt } = await import("../../../../../script.js");
		const fallbackResult = await generateQuietPrompt({ quietPrompt: fallbackPrompt });
		debug('Used standard generateQuietPrompt fallback for query');
		return fallbackResult;
	} catch (error) {
		errorToast('Error using connection profile for query');
		debug('ConnectionManagerRequestService error:', error);
		throw new Error(`Failed to generate query response: ${error.message}`);
	} finally {
		// Always reset the flag when done
		isInternalGeneration = false;
	}
}

// Query multiple chapters with a specific question
export async function queryChapters(startChapter, endChapter, query) {
	// Initialize commandArgs if not set
	if (!commandArgs) {
		commandArgs = {};
	}

	// Mark as internal generation to prevent timeline injection
	isInternalGeneration = true;

	try {
		// Check if timeline has any chapters
		if (!timelineData || timelineData.length === 0) {
			const msg = 'No chapters exist in the timeline yet.';
			errorToast(msg);
			return msg;
		}

		// Validate chapter range
		if (startChapter < 1 || startChapter > timelineData.length) {
			const msg = `Start chapter ${startChapter} does not exist. Valid chapter range is 1-${timelineData.length}.`;
			errorToast(msg);
			return msg;
		}
		if (endChapter < 1 || endChapter > timelineData.length) {
			const msg = `End chapter ${endChapter} does not exist. Valid chapter range is 1-${timelineData.length}.`;
			errorToast(msg);
			return msg;
		}
		if (startChapter > endChapter) {
			const msg = `Invalid range: start chapter ${startChapter} must be before or equal to end chapter ${endChapter}.`;
			errorToast(msg);
			return msg;
		}

		debug(`Querying chapters ${startChapter} to ${endChapter}`);

		// Collect all chapter histories and summaries
		const chaptersData = [];
		const chapterSummaries = [];

		for (let i = startChapter; i <= endChapter; i++) {
			const chapterHistory = await getChapterHistory(i);
			if (!chapterHistory) {
				const msg = `Chapter ${i} not found.`;
				errorToast(msg);
				return msg;
			}

			const chapter = timelineData[i - 1];
			chaptersData.push({
				number: i,
				history: chapterHistory,
				summary: chapter.summary
			});
			chapterSummaries.push(`Chapter ${i} Summary: ${chapter.summary}`);
		}

		const timelineContext = evaluateMacros('{{timeline}}', {});
		const timelineStr = typeof timelineContext === 'string' ? timelineContext : JSON.stringify(timelineContext, null, 2);

		// Format all chapters with headers
		const allChaptersContext = chaptersData.map(chapterData => {
			const chapterContent = chapterData.history.map((it) => `${it.name}: ${it.mes}`).join("\n\n");
			return `Chapter: ${chapterData.number}\n${chapterContent}`;
		}).join("\n\n");

		// Format all summaries with headers
		const allSummariesContext = chapterSummaries.join("\n\n");

		debug(`Total chapters context length: ${allChaptersContext.length} characters`);
		debug(`Timeline context length: ${timelineStr.length} characters`);
		debug(`Query: ${query}`);

		// Build the prompt - use simple string replacement to ensure it works
		let prompt = settings.chapter_query_prompt_template;

		// Replace macros in order - most specific first
		prompt = prompt.replace(/{{timeline}}/gi, timelineStr);
		prompt = prompt.replace(/{{chapter}}/gi, allChaptersContext);
		// Replace {{chapterSummary}} with all chapter summaries
		prompt = prompt.replace(/{{chapterSummary}}/gi, allSummariesContext);
		prompt = prompt.replace(/{{query}}/gi, query);

		// Then use substituteParams for any remaining standard macros like {{char}}, {{user}}, etc.
		const context = getContext();
		prompt = context.substituteParams(prompt, context.name1, context.name2);

		// Process system prompt with the same macro replacements
		let systemPrompt = '';
		if (settings.chapter_query_system_prompt && settings.chapter_query_system_prompt.trim()) {
			systemPrompt = settings.chapter_query_system_prompt;
			// Replace the same macros in system prompt
			systemPrompt = systemPrompt.replace(/{{timeline}}/gi, timelineStr);
			systemPrompt = systemPrompt.replace(/{{chapter}}/gi, allChaptersContext);
			// Replace {{chapterSummary}} with all chapter summaries
			systemPrompt = systemPrompt.replace(/{{chapterSummary}}/gi, allSummariesContext);
			systemPrompt = systemPrompt.replace(/{{query}}/gi, query);
			// Also substitute standard params
			systemPrompt = context.substituteParams(systemPrompt, context.name1, context.name2);
		}

		debug(`Final prompt length: ${prompt.length} characters`);
		debug(`System prompt length: ${systemPrompt.length} characters`);

		const chapterRange = startChapter === endChapter ? `chapter ${startChapter}` : `chapters ${startChapter}-${endChapter}`;
		infoToast(`Querying ${chapterRange}...`);

		const profileId = resolveConnectionProfileId(settings.query_profile, settings.profile);

		// Use ConnectionManagerRequestService if a profile is specified
		if (profileId && ConnectionManagerRequestService) {
			debug(`Using ConnectionManagerRequestService with profile: ${profileId}`);

			// Build messages array for the request
			const messages = [];
			if (systemPrompt) {
				messages.push({ role: 'system', content: systemPrompt });
			}
			messages.push({ role: 'user', content: prompt });

			// Get max tokens for the profile
			const maxTokens = await getMaxTokensForProfile(profileId);
			debug(`Using max tokens: ${maxTokens} for profile: ${profileId}`);

			// Build override payload for special cases like OpenAI o1 models
			const overridePayload = buildOverridePayload(profileId, maxTokens);

			// Get the reasoning effort value for this profile
			const reasoningEffort = getReasoningEffort(profileId);

			// Add reasoning_effort to override payload if it exists
			if (reasoningEffort !== undefined) {
				overridePayload.reasoning_effort = reasoningEffort;
			}
			const includeReasoning = getIncludeReasoning(profileId);
			if (includeReasoning !== undefined) {
				overridePayload.include_reasoning = includeReasoning;
			}

			// Use ConnectionManagerRequestService to send the request
			const result = await sendReliableApiRequest(
				profileId,              // profileId
				messages,                // prompt (as messages array)
				maxTokens,               // maxTokens
				{                        // custom options
					includePreset: true, // Include generation preset from profile
					stream: false        // Don't stream the response
				},
				overridePayload          // overridePayload with correct parameter names
			);

			// Extract content from response - parse reasoning if needed
			const content = result?.content || result || '';
			const parsed_reasoning = await reasoningParser(content, profileId);
			const final_content = parsed_reasoning ? parsed_reasoning.content : content;
			debug('Successfully used ConnectionManagerRequestService for query');
			return final_content;
		}

		// No profile: fallback to standard SillyTavern API
		const fallbackPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
		const { generateQuietPrompt } = await import("../../../../../script.js");
		const fallbackResult = await generateQuietPrompt({ quietPrompt: fallbackPrompt });
		debug('Used standard generateQuietPrompt fallback for query');
		return fallbackResult;
	} catch (error) {
		errorToast('Error using connection profile for query');
		debug('ConnectionManagerRequestService error:', error);
		throw new Error(`Failed to generate query response: ${error.message}`);
	} finally {
		// Always reset the flag when done
		isInternalGeneration = false;
	}
}

async function summarizeHistoryEntries(message_history, { targetMessageId, hideAfter = false, resummarizeChapterNumber = null } = {}) {
	if (!Array.isArray(message_history) || message_history.length === 0) {
		oopsToast("No visible chapter content! Skipping summary.");
		return "";
	}

	const max_tokens = getContext().maxContext - 100; // reserve space for instructions
	const getTokenCount = getContext().getTokenCountAsync;

	let chunks = [];
	let current = "";
	for (const mes of message_history) {
		const speaker = mes?.name ?? '';
		const content = mes?.mes ?? '';
		const mes_text = speaker.length ? `${speaker}: ${content}` : content;
		const next_text = current ? `${current}\n\n${mes_text}` : mes_text;
		const tokens = await getTokenCount((current || "") + mes_text);
		if (tokens > max_tokens && current.length) {
			chunks.push(current);
			current = mes_text;
		} else if (tokens > max_tokens) {
			// chunk would overflow even on first message; push as-is to avoid infinite loop
			chunks.push(mes_text);
			current = "";
		} else {
			current = next_text;
		}
	}
	if (current.length) chunks.push(current);

	let final_context;
	if (chunks.length === 1) {
		final_context = chunks[0];
	} else if (chunks.length > 1) {
		infoToast(`Generating summaries for ${chunks.length} chunks....`);
		const checkpointEnabled = hideAfter && targetMessageId !== undefined && resummarizeChapterNumber === null;
		const startMsgId = message_history[0]?.index ?? 0;
		const checkpointKey = getChapterCheckpointKey({
			startMsgId,
			targetMessageId,
			chunkCount: chunks.length,
		});
		const pendingCheckpoint = checkpointEnabled ? getPendingChapterCheckpoint() : null;
		const chunk_sums = matchesPendingChapterCheckpoint(pendingCheckpoint, {
			startMsgId,
			targetMessageId,
		})
			&& Array.isArray(pendingCheckpoint.chunkSummaries)
			? [...pendingCheckpoint.chunkSummaries]
			: [];

		if (chunk_sums.length > 0) {
			infoToast(`Resuming chapter summary from saved chunk ${chunk_sums.length + 1}/${chunks.length}.`);
		}

		let cid = 0;
		cid = Math.min(chunk_sums.length, chunks.length);
		while (cid < chunks.length) {
			let chunk_sum = '';
			try {
				chunk_sum = await genSummaryWithSlash(chunks[cid], Number(cid) + 1, { resummarizeChapterNumber });
			} catch (err) {
				if (checkpointEnabled) {
					savePendingChapterCheckpoint({
						checkpointKey,
						targetMessageId,
						startMsgId,
						chunkCount: chunks.length,
						chunkSummaries: chunk_sums,
						failedChunkIndex: cid,
						stage: 'chunk',
						error: err?.message || String(err),
					});
					errorToast(`Summary failed at chunk ${cid + 1}/${chunks.length}. Saved ${chunk_sums.length} completed chunk${chunk_sums.length === 1 ? '' : 's'}; fix the API profile and run chapter end again to continue.`);
					debug('Saved pending chapter checkpoint after chunk failure:', err);
					return "";
				}
				throw err;
			}
			if (chunk_sum.length > 0) {
				chunk_sums.push(chunk_sum);
				if (checkpointEnabled) {
					savePendingChapterCheckpoint({
						checkpointKey,
						targetMessageId,
						startMsgId,
						chunkCount: chunks.length,
						chunkSummaries: chunk_sums,
						failedChunkIndex: null,
						stage: 'chunks',
					});
				}
				cid++;
			} else {
				if (checkpointEnabled) {
					savePendingChapterCheckpoint({
						checkpointKey,
						targetMessageId,
						startMsgId,
						chunkCount: chunks.length,
						chunkSummaries: chunk_sums,
						failedChunkIndex: cid,
						stage: 'chunk',
						error: 'Empty chunk summary',
					});
					oopsToast(`Empty summary at chunk ${cid + 1}/${chunks.length}. Saved progress; run chapter end again after checking the API profile.`);
					return "";
				}
				const result = await getContext().Popup.show.text(
					"Fill the Time",
					"There was an error generating a summary for chunk #" + (Number(cid) + 1),
					{ okButton: 'Retry', cancelButton: 'Cancel' });
				if (result !== 1) return "";
			}
		}
		final_context = chunk_sums.join("\n\n");
	} else {
		oopsToast("No visible chapter content! Skipping summary.");
		return "";
	}

	if (!final_context?.length) {
		oopsToast("No final content - skipping summary.");
		return "";
	}

	let trimmedResult = '';
	if (chunks.length > 1 && settings.use_chunk_summaries_as_chapter) {
		infoToast("Using chunk summaries as chapter summary.");
		trimmedResult = final_context.trim();
	} else {
		infoToast("Generating chapter summary....");
		let result = '';
		try {
			result = await genSummaryWithSlash(final_context, 0, { resummarizeChapterNumber });
		} catch (err) {
			const checkpointEnabled = hideAfter && targetMessageId !== undefined && resummarizeChapterNumber === null && chunks.length > 1;
			if (checkpointEnabled) {
				const startMsgId = message_history[0]?.index ?? 0;
				savePendingChapterCheckpoint({
					checkpointKey: getChapterCheckpointKey({
						startMsgId,
						targetMessageId,
						chunkCount: chunks.length,
					}),
					targetMessageId,
					startMsgId,
					chunkCount: chunks.length,
					chunkSummaries: final_context.split(/\n\n+/).filter(Boolean),
					failedChunkIndex: null,
					stage: 'final',
					error: err?.message || String(err),
				});
				errorToast(`Final chapter summary failed. Saved ${chunks.length} chunk summaries; fix the API profile and run chapter end again to finish.`);
				debug('Saved pending chapter checkpoint after final summary failure:', err);
				return "";
			}
			throw err;
		}
		trimmedResult = typeof result === 'string' ? result.trim() : '';
	}

	if (trimmedResult.length > 0 && chunks.length > 1 && settings.add_chunk_summaries && targetMessageId !== undefined) {
		await runSlashCommand(`/comment at=${targetMessageId + 1} <details class="rmr-summary-chunks"><summary>Chunk Summaries</summary>${final_context}</details>`);
	}

	if (trimmedResult.length > 0 && hideAfter && settings.hide_chapter) {
		const chat = getContext().chat;
		for (const mes of message_history) {
			if (mes?.index === undefined) continue;
			chat[mes.index].is_system = true;
			const mes_elem = $(`.mes[mesid="${mes.index}"]`);
			if (mes_elem.length) mes_elem.attr('is_system', 'true');
		}
		getContext().saveChat();
	}

	if (!trimmedResult.length) {
		oopsToast("No final content - skipping summary.");
	}

	if (trimmedResult.length > 0 && hideAfter && targetMessageId !== undefined && resummarizeChapterNumber === null) {
		clearPendingChapterCheckpoint(targetMessageId);
	}

	return trimmedResult;
}

async function generateChapterSummary(mes_id) {
	const chat = getContext().chat;
	// slice to just the history from this message
	// slice to messages since the last chapter end, if there was one
	let last_end = chat.slice(0, mes_id + 1).findLastIndex((it) => it.extra?.rmr_chapter);
	if (last_end < 0) { last_end = 0; }
	const memory_history = await processMessageSlice(mes_id, 0, last_end);

	return await summarizeHistoryEntries(memory_history, { targetMessageId: mes_id, hideAfter: true });
}

// Simplified chapter summarization - just creates a summary
// Accepts either a message ID (number) or a jQuery element for backwards compatibility
export async function summarizeChapter(messageOrId, options = {}) {
	commandArgs = options;
	// Accept either a message ID (number) or a jQuery element
	const mes_id = typeof messageOrId === 'number'
		? messageOrId
		: Number(messageOrId.attr('mesid'));
	const chat = getContext().chat;

	// Find the last chapter end marker
	let last_end = chat.slice(0, mes_id + 1).findLastIndex((it) => it.extra?.rmr_chapter);
	if (last_end < 0) { last_end = 0; }

	let summary = '';
	try {
		summary = await generateChapterSummary(mes_id);
	} catch (err) {
		errorToast(`Chapter summary failed before the chapter was marked: ${err?.message || err}`);
		debug('Chapter summary failed:', err);
		return;
	}
	if (summary.length === 0) {
		errorToast("Chapter summary returned empty!");
		return;
	}

	// Add to timeline
	addChapterToTimeline(summary, last_end, mes_id);

	// Mark chapter end
	chat[mes_id].extra = chat[mes_id].extra || {};
	chat[mes_id].extra.rmr_chapter = true;
	getContext().saveChat();
	// Toggle highlight only if message is rendered (may not be visible in DOM)
	const highlightEl = $(`.mes[mesid="${mes_id}"] .rmr-button.fa-circle-stop`);
	if (highlightEl.length > 0) {
		toggleChapterHighlight(highlightEl, mes_id);
	}

	doneToast(`Chapter ${timelineData.length} added to timeline.`);
}

// Alias for backward compatibility
export async function endChapter(message, options = {}) {
	return summarizeChapter(message, options);
}

export async function resummarizeChapter(chapterNumber, options = {}) {
	commandArgs = options;
	loadTimelineData();
	if (!timelineData || timelineData.length === 0) {
		oopsToast("No chapters available to re-summarize.");
		return "";
	}

	if (chapterNumber < 1 || chapterNumber > timelineData.length) {
		errorToast(`Chapter ${chapterNumber} not found.`);
		return "";
	}

	const chapterIndex = chapterNumber - 1;
	const chapter = timelineData[chapterIndex];
	const chat = getContext().chat;
	const range = getChapterEffectiveRangeByIndex(chapterIndex);

	const startIdx = range?.startMsgId ?? 0;
	const endIdx = chapter.endMsgId;
	if (endIdx >= chat.length) {
		errorToast(`Chapter ${chapterNumber} references messages that are no longer available.`);
		return "";
	}

	const rawHistory = chat.slice(startIdx, endIdx + 1);
	if (!rawHistory.length) {
		oopsToast("No visible chapter content! Skipping summary.");
		return "";
	}

	const processedHistory = await Promise.all(rawHistory.map(async (message, offset) => {
		const absoluteIndex = startIdx + offset;
		let placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
		const depth = Math.max(0, chat.length - absoluteIndex - 1);
		const options = { isPrompt: true, depth };
		const original = message?.mes ?? '';
		const mes_text = message.is_system ? original : getRegexedString(original, placement, options);
		return {
			...message,
			mes: mes_text,
			index: absoluteIndex,
		};
	}));

	const summary = await summarizeHistoryEntries(processedHistory, { targetMessageId: endIdx, hideAfter: false, resummarizeChapterNumber: chapterNumber });
	if (!summary.length) {
		return "";
	}

	timelineData[chapterIndex].summary = summary;
	saveTimelineData();
	doneToast(`Chapter ${chapterNumber} summary updated.`);
	return summary;
}

// Removed lorebook functionality - these functions are no longer needed
export async function rememberEvent() {
	oopsToast("Memory events are no longer saved to lorebooks. Chapters are now tracked in the timeline.");
}

export async function logMessage() {
	oopsToast("Message logging to lorebooks has been removed. Use chapter summaries instead.");
}

export async function fadeMemories() {
	// No longer needed
}
