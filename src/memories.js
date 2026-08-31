import { extension_settings, getContext } from '../../../../extensions.js';
import { MacrosParser } from '../../../../macros.js';
import { getRegexedString, regex_placement } from '../../../regex/engine.js';
import { settings } from './settings.js';
import { debug } from './logging.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { amount_gen, main_api, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../script.js';
import { oai_settings, openai_settings, chat_completion_sources, reasoning_effort_types } from '../../../../../scripts/openai.js';
import { getPresetManager } from '../../../../../scripts/preset-manager.js';
import { createChatBackup } from './backup.js';

const CHAT_APIS = ['claude', 'openrouter', 'windowai', 'scale', 'ai21', 'makersuite', 'vertexai', 'mistralai', 'custom', 'google', 'cohere', 'perplexity', 'groq', '01ai', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations', 'moonshot', 'zai'];
const INJECT_KEY = 'FILLTHETIME_MEMORY_INJECT';
const PENDING_KEY = 'fillTheTimePendingChapter';
let rollingSummary = null;
let archiveEntries = [];
let isInternalGeneration = false;
let commandArgs = {};
let lastGenerationTimestamp = 0;
let endChapterInProgress = false;
const draftBases = new Map();
const regenerationBases = new Map();
const pendingChunkComments = new Map();
let progressStage = null;

async function setProgress(state) {
    try {
        const ui = await import('./settings.js');
        ui.updateChapterProgress?.(state ? { ...state, stage: progressStage } : null);
    } catch (error) { debug('Could not update chapter progress UI:', error); }
}

const infoToast = text => { if (!commandArgs?.quiet) toastr.info(text, 'Fill the Time'); };
const doneToast = text => { if (!commandArgs?.quiet) toastr.success(text, 'Fill the Time'); };
const warningToast = text => { if (!commandArgs?.quiet) toastr.warning(text, 'Fill the Time'); };
const errorToast = text => { if (!commandArgs?.quiet) toastr.error(text, 'Fill the Time'); };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function normalizeSummary(value) {
    if (!value || typeof value !== 'object') return null;
    const summary = String(value.summary || '').trim();
    const endMsgId = Number(value.endMsgId);
    if (!summary || !Number.isInteger(endMsgId) || endMsgId < 0) return null;
    return { summary, endMsgId, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString() };
}

function normalizeArchive(value) {
    const entry = normalizeSummary(value);
    if (!entry) return null;
    return { summary: entry.summary, endMsgId: entry.endMsgId, archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : entry.updatedAt };
}

function parseLegacyTimeline(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    const entries = [];
    const regex = /(?:Scene|Chapter)\s+(\d+)\s+\(Messages\s+(\d+)-(\d+)\):\s+(.+?)(?=\n\n(?:Scene|Chapter)\s+\d+|$)/gs;
    let match;
    while ((match = regex.exec(value)) !== null) entries.push({ summary: match[4].trim(), endMsgId: Number(match[3]) });
    return entries;
}

async function saveData({ chat = false } = {}) {
    const context = getContext();
    context.chatMetadata ||= {};
    if (rollingSummary) context.chatMetadata.fillTheTime = clone(rollingSummary);
    else delete context.chatMetadata.fillTheTime;
    context.chatMetadata.fillTheTimeArchive = clone(archiveEntries);
    await context.saveMetadata();
    if (chat) await context.saveChat();
}

async function refreshViews() {
    updateSummaryInjection();
    try {
        const ui = await import('./settings.js');
        await ui.renderActiveSummary?.();
        await ui.renderArchiveList?.();
        ui.renderPendingCheckpoint?.();
    } catch (error) { debug('Could not refresh summary UI:', error); }
    try {
        const messages = await import('./messages.js');
        messages.resetMessageButtons?.();
    } catch (error) { debug('Could not refresh message buttons:', error); }
}

export const getRollingSummary = () => clone(rollingSummary);
export const getArchiveEntries = () => clone(archiveEntries);

export async function loadRollingSummaryData() {
    draftBases.clear();
    regenerationBases.clear();
    pendingChunkComments.clear();
    const context = getContext();
    context.chatMetadata ||= {};
    rollingSummary = normalizeSummary(context.chatMetadata.fillTheTime);
    archiveEntries = Array.isArray(context.chatMetadata.fillTheTimeArchive) ? context.chatMetadata.fillTheTimeArchive.map(normalizeArchive).filter(Boolean) : [];
    const legacy = parseLegacyTimeline(context.chatMetadata.timeline)
        .map(item => ({ summary: String(item?.summary || '').trim(), endMsgId: Number(item?.endMsgId) }))
        .filter(item => item.summary && Number.isInteger(item.endMsgId) && item.endMsgId >= 0 && item.endMsgId < (context.chat || []).length)
        .sort((a, b) => a.endMsgId - b.endMsgId);
    if (rollingSummary && rollingSummary.endMsgId >= (context.chat || []).length) {
        debug('Discarding rolling summary with an out-of-range message ID.');
        rollingSummary = null;
    }
    if (!rollingSummary && legacy.length) {
        rollingSummary = { summary: legacy.map((item, index) => `Chapter ${index + 1}: ${item.summary}`).join('\n\n'), endMsgId: legacy.at(-1).endMsgId, updatedAt: new Date().toISOString() };
        archiveEntries.push(...legacy.slice(0, -1).map(item => ({ summary: item.summary, endMsgId: item.endMsgId, archivedAt: new Date().toISOString() })));
        clearMarkers();
        if (context.chat?.[rollingSummary.endMsgId]) {
            context.chat[rollingSummary.endMsgId].extra ||= {};
            context.chat[rollingSummary.endMsgId].extra.rmr_chapter = true;
        }
        delete context.chatMetadata.timeline;
        delete context.chatMetadata.timelineFillResults;
        await saveData({ chat: true });
        infoToast(`Migrated ${legacy.length} chapters into one rolling summary.`);
    } else {
        let markersChanged = false;
        for (let index = 0; index < (context.chat || []).length; index++) {
            const shouldBeMarked = rollingSummary?.endMsgId === index;
            if (Boolean(context.chat[index]?.extra?.rmr_chapter) !== shouldBeMarked) {
                context.chat[index].extra ||= {};
                context.chat[index].extra.rmr_chapter = shouldBeMarked;
                markersChanged = true;
            }
        }
        if (!rollingSummary) delete context.chatMetadata.fillTheTime;
        context.chatMetadata.fillTheTimeArchive = clone(archiveEntries);
        if (markersChanged) await context.saveChat();
        await context.saveMetadata();
    }
    updateSummaryInjection();
    return getRollingSummary();
}

export async function deleteArchiveEntry(index) {
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= archiveEntries.length) return false;
    archiveEntries.splice(index, 1);
    await saveData();
    await refreshViews();
    return true;
}

export async function updateRollingSummaryText(text) {
    text = String(text || '').trim();
    if (!rollingSummary || !text) return false;
    rollingSummary.summary = text;
    rollingSummary.updatedAt = new Date().toISOString();
    await saveData();
    await refreshViews();
    return true;
}

function clearMarkers() {
    for (const message of getContext().chat || []) if (message?.extra?.rmr_chapter) message.extra.rmr_chapter = false;
}

function unhideRange(start, end) {
    const chat = getContext().chat || [];
    start = Math.max(0, Number(start) || 0);
    end = Math.min(Number(end), chat.length - 1);
    for (let index = start; index <= end; index++) {
        if (!chat[index]) continue;
        chat[index].is_system = false;
        $(`.mes[mesid="${index}"]`).attr('is_system', 'false');
    }
}

export async function restorePreviousFromArchive() {
    if (!rollingSummary) return false;
    const chat = getContext().chat || [];
    let restored = null;
    while (archiveEntries.length && !restored) {
        const candidate = normalizeArchive(archiveEntries.pop());
        if (candidate && candidate.endMsgId < chat.length) restored = candidate;
    }
    if (!restored) {
        await saveData();
        return false;
    }
    const oldEnd = rollingSummary.endMsgId;
    rollingSummary = { summary: restored.summary, endMsgId: restored.endMsgId, updatedAt: new Date().toISOString() };
    clearMarkers();
    if (chat[restored.endMsgId]) {
        chat[restored.endMsgId].extra ||= {};
        chat[restored.endMsgId].extra.rmr_chapter = true;
    }
    unhideRange(restored.endMsgId + 1, oldEnd);
    await saveData({ chat: true });
    await refreshViews();
    doneToast('Restored the latest archived summary.');
    return true;
}

export async function clearRollingSummary() {
    const oldEnd = rollingSummary?.endMsgId;
    rollingSummary = null;
    draftBases.clear();
    regenerationBases.clear();
    pendingChunkComments.clear();
    clearMarkers();
    if (Number.isInteger(oldEnd)) unhideRange(0, oldEnd);
    await clearCheckpoint();
    await saveData({ chat: true });
    await refreshViews();
    doneToast('Created an empty summary. You can summarize the chat again.');
    return true;
}

export function initFillTheTimeMacros() {
    MacrosParser.registerMacro('fillthetime', () => isInternalGeneration ? '' : (rollingSummary?.summary || ''), 'Active cumulative Fill the Time summary');
    MacrosParser.registerMacro('lastMessageId', () => Math.max(0, (getContext().chat || []).length - 1), 'Most recent message ID');
    MacrosParser.registerMacro('firstIncludedMessageId', () => rollingSummary ? rollingSummary.endMsgId + 1 : 0, 'First message after the active summary');
}

export function updateSummaryInjection() {
    if (!settings?.inject_enabled) {
        setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const context = getContext();
    let prompt = String(settings.inject_prompt || '');
    prompt = prompt.replace(/{{fillthetime}}/gi, rollingSummary?.summary || '');
    prompt = prompt.replace(/{{lastMessageId}}/gi, String(Math.max(0, (context.chat || []).length - 1)));
    prompt = prompt.replace(/{{firstIncludedMessageId}}/gi, String(rollingSummary ? rollingSummary.endMsgId + 1 : 0));
    prompt = context.substituteParams(prompt, context.name1, context.name2);
    setExtensionPrompt(INJECT_KEY, prompt, extension_prompt_types.IN_CHAT, Number(settings.inject_depth) || 0, false, settings.inject_role ?? extension_prompt_roles.SYSTEM, () => !isInternalGeneration);
}

function profiles() { return Array.isArray(extension_settings?.connectionManager?.profiles) ? extension_settings.connectionManager.profiles : []; }
export function isValidConnectionProfileId(id) { return typeof id === 'string' && id.length > 0 && profiles().some(profile => profile.id === id); }
export function resolveConnectionProfileId(...ids) {
    for (const id of ids) if (isValidConnectionProfileId(id)) return id;
    const selected = extension_settings?.connectionManager?.selectedProfile;
    return isValidConnectionProfileId(selected) ? selected : null;
}

export function getReasoningEffort(profileId) {
    try {
        const profile = profiles().find(item => item.id === profileId);
        if (!profile) return oai_settings.reasoning_effort;
        let effort = null;
        if (profile.preset) {
            const api = CHAT_APIS.includes(profile.api) || profile.api === 'openai' ? 'openai' : profile.api;
            const manager = getPresetManager(api);
            if (api === 'openai' && manager) {
                const index = manager.getAllPresets().indexOf(profile.preset);
                effort = index >= 0 ? openai_settings[index]?.reasoning_effort : null;
            }
        }
        effort ||= oai_settings.reasoning_effort;
        const source = ({ openai: chat_completion_sources.OPENAI, custom: chat_completion_sources.CUSTOM, xai: chat_completion_sources.XAI, aimlapi: chat_completion_sources.AIMLAPI, openrouter: chat_completion_sources.OPENROUTER, pollinations: chat_completion_sources.POLLINATIONS, perplexity: chat_completion_sources.PERPLEXITY })[profile.api] || profile.api;
        const mapped = [chat_completion_sources.OPENAI, chat_completion_sources.CUSTOM, chat_completion_sources.XAI, chat_completion_sources.AIMLAPI, chat_completion_sources.OPENROUTER, chat_completion_sources.POLLINATIONS, chat_completion_sources.PERPLEXITY, chat_completion_sources.COMETAPI];
        if (!mapped.includes(source)) return effort;
        if (effort === reasoning_effort_types.auto) return undefined;
        if (effort === reasoning_effort_types.min) return source === chat_completion_sources.OPENAI && profile.model?.startsWith('gpt-5') ? 'min' : 'low';
        return effort === reasoning_effort_types.max ? 'high' : effort;
    } catch (error) { debug('Reasoning effort lookup failed:', error); return oai_settings.reasoning_effort; }
}

export function getIncludeReasoning(profileId) {
    const profile = profiles().find(item => item.id === profileId);
    return profile?.api === 'zai' ? Boolean(oai_settings.show_thoughts) : undefined;
}

export async function getMaxTokensForProfile(profileId) {
    if (!profileId || profileId === 'current') return ['openai', 'openrouter', 'claude'].includes(main_api) ? (oai_settings.openai_max_tokens || amount_gen || 2048) : (amount_gen || 2048);
    try {
        const profile = profiles().find(item => item.id === profileId);
        if (!profile?.preset) return amount_gen || 2048;
        const api = CHAT_APIS.includes(profile.api) || profile.api === 'openai' ? 'openai' : profile.api;
        const manager = getPresetManager(api);
        let preset = null;
        if (api === 'openai' && manager) {
            const index = manager.getAllPresets().indexOf(profile.preset);
            preset = index >= 0 ? openai_settings[index] : null;
        } else preset = manager?.getPresetSettings(profile.preset);
        return preset?.openai_max_tokens || preset?.max_tokens || preset?.max_length || preset?.genamt || amount_gen || 2048;
    } catch (error) { debug('Max-token lookup failed:', error); return amount_gen || 2048; }
}

export function buildOverridePayload(profileId, maxTokens) {
    const profile = profiles().find(item => item.id === profileId);
    if (!(profile?.api === 'openai' && /^(o1|o3|o4|gpt-5)/.test(profile.model || ''))) return {};
    return { max_tokens: undefined, max_completion_tokens: maxTokens, temperature: 1, top_p: undefined, frequency_penalty: undefined, presence_penalty: undefined };
}

async function sendRequest(profileId, messages, maxTokens, overridePayload) {
    if (profileId && ConnectionManagerRequestService) {
        try { return await ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, { includePreset: true, includeInstruct: true, stream: false }, overridePayload); }
        catch (error) { debug('Profile request failed; falling back:', error); }
    }
    const { generateQuietPrompt } = await import('../../../../../script.js');
    return { content: await generateQuietPrompt({ quietPrompt: messages.map(item => item.content).join('\n\n') }) };
}

function pendingCheckpoint() { const value = getContext().chatMetadata?.[PENDING_KEY]; return value && typeof value === 'object' ? value : null; }
async function saveCheckpoint(value) {
    const context = getContext();
    context.chatMetadata ||= {};
    context.chatMetadata[PENDING_KEY] = { ...value, updatedAt: new Date().toISOString() };
    await context.saveMetadata();
}
async function clearCheckpoint(target = null, checkpointType = null) {
    const context = getContext();
    const pending = context.chatMetadata?.[PENDING_KEY];
    const pendingType = pending?.checkpointType || 'forward';
    if (!pending || (target !== null && Number(pending.targetMessageId) !== Number(target)) || (checkpointType && pendingType !== checkpointType)) return;
    delete context.chatMetadata[PENDING_KEY];
    await context.saveMetadata();
}

async function processRange(start, end, { includeHidden = false } = {}) {
    const context = getContext();
    const chat = context.chat || [];
    const length = chat.length;
    const processed = await Promise.all(chat.slice(start, end + 1).map(async (message, offset) => {
        const index = start + offset;
        const placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const mes = message.is_system ? message.mes : getRegexedString(message.mes, placement, { isPrompt: true, depth: Math.max(0, length - index - 1) });
        return { ...message, mes, index };
    }));
    return processed.filter(message => includeHidden || !message.is_system);
}

async function generateFromText(content, chunk = 0, includePrevious = true, previousOverride = null) {
    const rate = Number(settings.rate_limit) || 0;
    const delay = rate > 0 ? Math.max(500, 60000 / rate) : 0;
    const remaining = delay - (Date.now() - lastGenerationTimestamp);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    lastGenerationTimestamp = Date.now();
    if (chunk) infoToast(`Generating chunk summary ${chunk}...`);
    isInternalGeneration = true;
    try {
        const context = getContext();
        const previous = includePrevious ? (previousOverride ?? rollingSummary?.summary ?? '') : '';
        let userPrompt = String(settings.memory_prompt_template || '').replace(/{{content}}/gi, String(content || '').trim()).replace(/{{previousSummary}}/gi, previous);
        let systemPrompt = String(settings.memory_system_prompt || '').replace(/{{content}}/gi, String(content || '').trim()).replace(/{{previousSummary}}/gi, previous);
        userPrompt = context.substituteParams(userPrompt, context.name1, context.name2);
        systemPrompt = context.substituteParams(systemPrompt, context.name1, context.name2);
        const messages = [];
        if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userPrompt });
        const profileId = resolveConnectionProfileId(commandArgs?.profile, settings.profile);
        const maxTokens = await getMaxTokensForProfile(profileId);
        const override = buildOverridePayload(profileId, maxTokens);
        const effort = getReasoningEffort(profileId);
        if (effort !== undefined) override.reasoning_effort = effort;
        const include = getIncludeReasoning(profileId);
        if (include !== undefined) override.include_reasoning = include;
        const response = await sendRequest(profileId, messages, maxTokens, override);
        const raw = response?.content || response || '';
        return String(context.parseReasoningFromString?.(raw)?.content ?? raw).trim();
    } finally { isInternalGeneration = false; }
}

async function summarizeHistory(history, target, options = {}) {
    if (!history.length) { warningToast('No visible content to summarize.'); return ''; }
    const context = getContext();
    const maxTokens = Math.max(100, Number(context.maxContext || 4096) - 100);
    const chunks = [];
    let current = '';
    for (const message of history) {
        const text = `${message.name ? `${message.name}: ` : ''}${message.mes || ''}`;
        const candidate = current ? `${current}\n\n${text}` : text;
        let tokens;
        try { tokens = await context.getTokenCountAsync(candidate); } catch { tokens = Math.ceil(candidate.length / 4); }
        if (tokens > maxTokens && current) { chunks.push(current); current = text; }
        else if (tokens > maxTokens) { chunks.push(text); current = ''; }
        else current = candidate;
    }
    if (current) chunks.push(current);
    if (!chunks.length) return '';
    const start = history[0].index ?? 0;
    const persistCheckpoint = options.persistCheckpoint !== false;
    const pending = persistCheckpoint ? pendingCheckpoint() : null;
    const checkpointType = options.checkpointType || 'forward';
    const pendingType = pending?.checkpointType || 'forward';
    let summaries = pending && pendingType === checkpointType && Number(pending.startMsgId) === start && Number(pending.targetMessageId) === target && Number(pending.chunkCount) === chunks.length && Array.isArray(pending.chunkSummaries) ? [...pending.chunkSummaries] : [];
    if (summaries.length) infoToast(`Resuming from chunk ${summaries.length + 1}/${chunks.length}.`);
    if (chunks.length > 1) {
        while (summaries.length < chunks.length) {
            const index = summaries.length;
            await setProgress({ phase: 'chunks', current: index, total: chunks.length });
            try {
                const result = await generateFromText(chunks[index], index + 1, false);
                if (!result) throw new Error('Empty chunk summary');
                summaries.push(result);
                if (persistCheckpoint) await saveCheckpoint({ checkpointType, targetMessageId: target, startMsgId: start, chunkCount: chunks.length, chunkSummaries: summaries, stage: 'chunks' });
                await setProgress({ phase: 'chunks', current: summaries.length, total: chunks.length });
            } catch (error) {
                if (persistCheckpoint) await saveCheckpoint({ checkpointType, targetMessageId: target, startMsgId: start, chunkCount: chunks.length, chunkSummaries: summaries, stage: 'chunk', failedChunkIndex: index, error: error?.message || String(error) });
                errorToast(persistCheckpoint ? `Summary failed at chunk ${index + 1}/${chunks.length}. Progress was saved.` : `Summary failed at chunk ${index + 1}/${chunks.length}.`);
                await setProgress(null);
                return '';
            }
        }
    }
    const combined = chunks.length === 1 ? chunks[0] : summaries.join('\n\n');
    let result;
    try {
        if (chunks.length > 1 && settings.use_chunk_summaries_as_chapter) {
            const previous = options.previousSummary ?? rollingSummary?.summary ?? '';
            result = previous ? `${previous}\n\n${combined}`.trim() : combined;
        } else {
            await setProgress({ phase: 'final', current: chunks.length, total: chunks.length });
            result = await generateFromText(combined, 0, true, options.previousSummary);
        }
    }
    catch (error) {
        if (persistCheckpoint) await saveCheckpoint({ checkpointType, targetMessageId: target, startMsgId: start, chunkCount: chunks.length, chunkSummaries: summaries, stage: 'final', error: error?.message || String(error) });
        errorToast(persistCheckpoint ? 'Final summary failed. Chunk progress was saved.' : 'Final summary failed.');
        await setProgress(null);
        return '';
    }
    await setProgress(null);
    result = String(result || '').trim();
    if (result && chunks.length > 1 && settings.add_chunk_summaries && options.addChunkComment !== false) {
        pendingChunkComments.set(target, combined);
    } else {
        pendingChunkComments.delete(target);
    }
    return result;
}

export async function generateRollingSummary(messageId, options = {}) {
    commandArgs = { ...options };
    const target = Number(messageId);
    const chat = getContext().chat || [];
    if (!Number.isInteger(target) || target < 0 || target >= chat.length) { errorToast(`Message ID must be between 0 and ${Math.max(0, chat.length - 1)}.`); return ''; }
    const oldEnd = rollingSummary?.endMsgId ?? -1;
    if (target <= oldEnd) { errorToast(`Choose a message after ${oldEnd}; earlier content is already summarized.`); return ''; }
    draftBases.set(target, { endMsgId: oldEnd, updatedAt: rollingSummary?.updatedAt || null, summary: rollingSummary?.summary || '' });
    return summarizeHistory(await processRange(oldEnd + 1, target), target);
}

function summarySignature(value) {
    return `${value?.endMsgId ?? -1}|${value?.updatedAt || ''}|${value?.summary || ''}`;
}

export async function generateActiveSummaryReplacement(options = {}) {
    if (!rollingSummary) { warningToast('No active summary to regenerate.'); return ''; }
    commandArgs = { ...options };
    const active = clone(rollingSummary);
    const base = archiveEntries
        .filter(entry => Number(entry.endMsgId) < active.endMsgId)
        .sort((a, b) => a.endMsgId - b.endMsgId)
        .at(-1) || null;
    const start = base ? base.endMsgId + 1 : 0;
    const signature = summarySignature(active);
    regenerationBases.set(active.endMsgId, { signature, start, previousSummary: base?.summary || '' });
    const result = await summarizeHistory(await processRange(start, active.endMsgId, { includeHidden: true }), active.endMsgId, { previousSummary: base?.summary || '', checkpointType: `regeneration:${signature}`, persistCheckpoint: false, addChunkComment: false });
    if (result && summarySignature(rollingSummary) !== signature) {
        errorToast('The active summary changed during regeneration. Generate it again.');
        return '';
    }
    return result;
}

export async function acceptActiveSummaryReplacement(text, endMsgId) {
    const summary = String(text || '').trim();
    const target = Number(endMsgId);
    const base = regenerationBases.get(target);
    if (!summary || !rollingSummary || target !== rollingSummary.endMsgId || !base || base.signature !== summarySignature(rollingSummary)) {
        errorToast('The active summary changed while this proposal was open. Generate it again.');
        return false;
    }
    await createChatBackup('active summary regeneration');
    rollingSummary = { ...rollingSummary, summary, updatedAt: new Date().toISOString() };
    regenerationBases.delete(target);
    pendingChunkComments.delete(target);
    await saveData({ chat: true });
    await refreshViews();
    doneToast('Active summary regenerated.');
    return true;
}

export async function regenerateActiveSummary(options = {}) {
    if (endChapterInProgress) { warningToast('A rolling summary is already being generated.'); return false; }
    if (!rollingSummary) { warningToast('No active summary to regenerate.'); return false; }
    endChapterInProgress = true;
    try {
        let proposal;
        try { proposal = await generateActiveSummaryReplacement(options); }
        catch (error) { errorToast(`Summary failed: ${error?.message || error}`); debug('Active summary regeneration failed:', error); return false; }
        if (!proposal) return false;
        const { openRegenerationPopup } = await import('./settings.js');
        return await openRegenerationPopup(proposal, rollingSummary.endMsgId);
    } finally { endChapterInProgress = false; }
}

export async function acceptRollingSummary(text, endMsgId, archiveOld = true) {
    const summary = String(text || '').trim();
    const target = Number(endMsgId);
    const context = getContext();
    const chat = context.chat || [];
    if (!summary || !Number.isInteger(target) || target < 0 || target >= chat.length) return false;
    const old = clone(rollingSummary);
    const oldEnd = old?.endMsgId ?? -1;
    const base = draftBases.get(target);
    const currentSignature = `${oldEnd}|${old?.updatedAt || ''}|${old?.summary || ''}`;
    const baseSignature = `${base?.endMsgId ?? -1}|${base?.updatedAt || ''}|${base?.summary || ''}`;
    if (!base || currentSignature !== baseSignature || target <= oldEnd) {
        errorToast('The active summary changed while this proposal was open. Generate it again.');
        return false;
    }
    if (archiveOld && old) {
        const last = archiveEntries.at(-1);
        if (!last || last.summary !== old.summary || last.endMsgId !== old.endMsgId) archiveEntries.push({ summary: old.summary, endMsgId: old.endMsgId, archivedAt: new Date().toISOString() });
    }
    rollingSummary = { summary, endMsgId: target, updatedAt: new Date().toISOString() };
    clearMarkers();
    chat[target].extra ||= {};
    chat[target].extra.rmr_chapter = true;
    if (settings.hide_chapter) {
        for (let index = oldEnd + 1; index <= target; index++) {
            if (!chat[index]) continue;
            chat[index].is_system = true;
            $(`.mes[mesid="${index}"]`).attr('is_system', 'true');
        }
    }
    await clearCheckpoint(target);
    const chunkComment = pendingChunkComments.get(target);
    if (chunkComment) {
        try { await context.executeSlashCommandsWithOptions(`/comment at=${target + 1} <details class="rmr-summary-chunks"><summary>Chunk Summaries</summary>${chunkComment}</details>`); }
        catch (error) { debug('Could not add accepted chunk-summary comment:', error); }
    }
    pendingChunkComments.delete(target);
    draftBases.delete(target);
    await saveData({ chat: true });
    await refreshViews();
    doneToast('Rolling summary updated.');
    return true;
}

export async function autoSplitSummarize(messageId, stages = 1, options = {}) {
    if (endChapterInProgress) {
        warningToast('A rolling summary is already being generated.');
        return false;
    }
    endChapterInProgress = true;
    try {
        commandArgs = { ...options };
        const context = getContext();
        const chat = context.chat || [];
        const target = Number(messageId);
        if (!Number.isInteger(target) || target < 0 || target >= chat.length) { errorToast(`Message ID must be between 0 and ${Math.max(0, chat.length - 1)}.`); return false; }
        const oldEnd = rollingSummary?.endMsgId ?? -1;
        if (target <= oldEnd) { errorToast(`Choose a message after ${oldEnd}; earlier content is already summarized.`); return false; }
        await createChatBackup('auto-split rolling summary');
        const counts = [];
        for (let index = oldEnd + 1; index <= target; index++) {
            const message = chat[index];
            const text = `${message?.name ? `${message.name}: ` : ''}${message?.mes || ''}`;
            try { counts.push(await context.getTokenCountAsync(text)); } catch { counts.push(Math.ceil(text.length / 4)); }
        }
        const total = counts.reduce((sum, value) => sum + value, 0);
        const maxTokens = Math.max(100, Number(context.maxContext || 4096) - 100);
        let count = Math.max(0, Number(stages) || 0);
        if (!count) count = Math.max(1, Math.ceil(total / maxTokens));
        count = Math.min(count, target - oldEnd);
        const per = total / count;
        const cutSet = new Set();
        let acc = 0;
        for (let index = 0; index < counts.length && cutSet.size < count - 1; index++) {
            acc += counts[index];
            if (acc >= per * (cutSet.size + 1)) cutSet.add(oldEnd + 1 + index);
        }
        const cuts = [...cutSet].filter(id => id < target).sort((a, b) => a - b);
        cuts.push(target);
        if (cuts.length > 1) infoToast(`Splitting messages ${oldEnd + 1}-${target} (~${total} tokens) into ${cuts.length} stages.`);
        for (let stage = 0; stage < cuts.length; stage++) {
            const end = cuts[stage];
            const isLast = stage === cuts.length - 1;
            progressStage = cuts.length > 1 ? { current: stage + 1, total: cuts.length } : null;
            if (cuts.length > 1) infoToast(`Stage ${stage + 1}/${cuts.length}: summarizing through message ${end}...`);
            let proposal;
            try { proposal = await generateRollingSummary(end, options); }
            catch (error) { errorToast(`Stage ${stage + 1} failed: ${error?.message || error}`); debug('Auto-split stage failed:', error); return false; }
            if (!proposal) { if (cuts.length > 1) warningToast(`Auto-split stopped at stage ${stage + 1}/${cuts.length}. Accepted stages were kept.`); return false; }
            if (!isLast && options.autoAcceptIntermediate !== false) {
                if (!await acceptRollingSummary(proposal, end, stage === 0 && settings.archive_on_accept)) { warningToast(`Could not accept stage ${stage + 1}. Stopping.`); return false; }
            } else {
                const { openReviewPopup } = await import('./settings.js');
                const archiveDefault = cuts.length > 1 && stage > 0 ? false : undefined;
                const accepted = await openReviewPopup(proposal, end, archiveDefault);
                if (!accepted) { if (!isLast) warningToast('Auto-split cancelled. Accepted stages were kept.'); return false; }
            }
        }
        if (cuts.length > 1) doneToast(`Auto-split complete: ${cuts.length} stages merged into the rolling summary.`);
        return true;
    } finally {
        endChapterInProgress = false;
        progressStage = null;
        await setProgress(null);
    }
}

export function getPendingCheckpoint() {
    const pending = pendingCheckpoint();
    if (!pending || (pending.checkpointType || 'forward') !== 'forward') return null;
    const chat = getContext().chat || [];
    const target = Number(pending.targetMessageId);
    if (!Number.isInteger(target) || target < 0 || target >= chat.length) return null;
    return {
        targetMessageId: target,
        chunkCount: Number(pending.chunkCount) || 0,
        chunksDone: Array.isArray(pending.chunkSummaries) ? pending.chunkSummaries.length : 0,
        stage: pending.stage || 'chunks',
        updatedAt: pending.updatedAt || null,
    };
}

export async function resumePendingCheckpoint(options = {}) {
    const pending = getPendingCheckpoint();
    if (!pending) { warningToast('No saved chapter progress to resume.'); return false; }
    return endChapter(pending.targetMessageId, options);
}

export async function discardPendingCheckpoint() {
    const context = getContext();
    if (!context.chatMetadata?.[PENDING_KEY]) return false;
    delete context.chatMetadata[PENDING_KEY];
    await context.saveMetadata();
    try { (await import('./settings.js')).renderPendingCheckpoint?.(); } catch (error) { debug('Could not refresh checkpoint UI:', error); }
    doneToast('Saved chapter progress discarded.');
    return true;
}

export async function endChapter(messageOrId, options = {}) {
    if (endChapterInProgress) {
        warningToast('A rolling summary is already being generated.');
        return false;
    }
    endChapterInProgress = true;
    try {
        const target = typeof messageOrId === 'number' ? messageOrId : Number(messageOrId?.attr?.('mesid'));
        commandArgs = { ...options };
        await createChatBackup('rolling summary update');
        let proposal;
        try { proposal = await generateRollingSummary(target, options); }
        catch (error) { errorToast(`Summary failed: ${error?.message || error}`); debug('Summary failed:', error); return false; }
        if (!proposal) return false;
        const { openReviewPopup } = await import('./settings.js');
        return await openReviewPopup(proposal, target);
    } finally {
        endChapterInProgress = false;
    }
}
