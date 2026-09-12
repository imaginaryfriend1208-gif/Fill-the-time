import { extension_settings, getContext } from '../../../../extensions.js';
import { extension_prompt_roles } from '../../../../../script.js';
import { extension_name, getExtensionAssetPath } from '../index.js';
import { resetMessageButtons } from './messages.js';
import { debug } from './logging.js';
import { initTutorialUI, refreshTutorialLocale } from './tutorial.js';
import { applyExtensionLocale, getAvailableLocales, getText, setExtensionLocale } from './locales.js';

export let settings;
export const Buttons = { STOP: 'chapter_button' };

const SYSTEM_PROMPT = `<role>You maintain one rolling summary of an ongoing story.</role>
<task>Merge the previous cumulative summary and newest events into one updated cumulative summary.</task>
<instructions>Preserve critical plot developments, character changes, relationships, resolved conflicts, and unresolved threads. Compress older events more than recent events. Never discard prior facts unless newer events supersede them. Exclude minor description and dialogue excerpts. Return plain unformatted text only.</instructions>`;
const USER_PROMPT = `<previous_summary>
{{previousSummary}}
</previous_summary>

<new_events>
{{content}}
</new_events>

Merge the previous summary and new events into ONE concise cumulative summary of the entire story so far. If the previous summary is empty, summarize only the new events. Return one plaintext block without bullets or markdown.

The updated cumulative summary is:`;
const CHUNK_SYSTEM_PROMPT = `<role>You condense one portion of an ongoing story.</role>
<task>Summarize the given events into a compact, self-contained digest.</task>
<instructions>Preserve plot developments, character actions, decisions, relationships, reveals, and unresolved threads in chronological order. Keep names, dates, and concrete facts. Exclude minor description and dialogue excerpts. Return plain unformatted text only.</instructions>`;
const CHUNK_USER_PROMPT = `<events>
{{content}}
</events>

Summarize the events above into ONE compact chronological digest. Return one plaintext block without bullets or markdown.

The digest is:`;
const INJECT_PROMPT = `<story_summary>
{{fillthetime}}
</story_summary>
The above is the cumulative story summary before message {{firstIncludedMessageId}}. The current message ID is {{lastMessageId}}. If the tag is empty, no summary exists yet.`;
const DIARY_USER_PROMPT = `<previous_diary>
{{previousSummary}}
</previous_diary>

<new_events>
{{content}}
</new_events>

Merge the previous diary and the new events into ONE updated diary following your role and format. If the previous diary is empty, start the diary from the new events.

Merge rules:
- Keep every dated entry and every (REMEMBER: ...) note that is still valid.
- Note in detail what got DONE in the previous chapters (tasks finished, promises kept, problems solved) and what is still HANGING (unfinished tasks, promises not yet kept, questions with no answer yet). Carry every hanging item forward so nothing is silently dropped.
- Never delete old memories. When compressing older entries, retell them in the diarist's own narrating voice, as someone looking back on things that already happened (e.g. "back then we...", "that was the day..."), keeping the facts, dates, and feelings intact while shortening the wording.

Write the entire diary in English. Return one plaintext block without markdown.

The updated diary is:`;
const WRITER_DIARY_SYSTEM = `<role>You are the story's writer, keeping a private development diary about an ongoing story. You write in third person limited: every event is recorded strictly through what each character personally knows, saw, or believes at that time. Never leak one character's secret knowledge into another character's understanding.</role>
<task>Merge the previous diary and the newest events into ONE updated development diary. Always write the entire diary in English, regardless of the story's language. Do not leave out events to save space; only compress wording, never content.</task>
<format>
Write the diary with these sections:
[CHRONICLE] Dated diary entries of ALL events so far, oldest first. Whenever the story states or implies a date, time, day of week, season, or elapsed time, record it explicitly (e.g. "Day 12, evening", "Sunday, March 3rd"). Mark anniversaries, birthdays, promises, and memorable firsts with (REMEMBER: ...) so they can be celebrated or called back later. You may add short asides in parentheses, like (NOTE: ...) for writer observations about a character or (PLAN: ...) for ideas on where to take them. Compress older entries more than recent ones, but never delete a recorded event or a REMEMBER note unless newer events supersede them.
[WHO KNOWS WHAT] For each major character: what they currently know, believe (possibly wrongly), and still do not know.
[OPEN THREADS & PLAN] Every unresolved or open thread: what was set up, what is still owed to the reader, and a short concrete plan for how it could be developed or paid off later.
</format>
<instructions>Preserve critical plot developments, character changes, relationships, resolved conflicts, and unresolved threads. Exclude minor description and dialogue excerpts. Write in plain everyday language, like quick working notes, not literary or flowery prose. Never use em dashes or en dashes in any form (—, –, or --); use commas, periods, or parentheses instead. Return plain unformatted text only, no markdown.</instructions>`;
const CHARACTER_DIARY_SYSTEM = `<role>You are {{char}}, privately writing in your personal diary at the end of the most recent scene. Write in first person, in {{char}}'s authentic voice. Always write the entire diary in English, regardless of the story's language. You only know what {{char}} personally witnessed, was told, or believes. You may be wrong about things, and you must not mention anything {{char}} could not know.</role>
<task>Rewrite your diary by merging the previous diary with what just happened, into ONE updated diary. Do not leave out events to save space; only compress wording, never content.</task>
<format>
Write dated diary entries, oldest first. Whenever you know a date, time, day of week, or how much time has passed, write it down (e.g. "Day 12, evening", "Sunday, March 3rd"). Mark anniversaries, birthdays, promises, and memorable firsts with (REMEMBER: ...) so future-you can celebrate or bring them up again. For each entry, record not only what happened but where you were, the atmosphere, and honestly how you felt in that moment: your emotions, doubts, hopes, and what you privately think of the people involved. You may add little personal asides in parentheses, like (note to self: ...) or (plan: ...), the way people scribble in real diaries.
End the diary with a short "Things still on my mind" section: unfinished business, unanswered questions, promises to keep, and what you intend to do next.
Compress older entries more than recent ones, but never delete a recorded event or a REMEMBER note unless newer events change their meaning.
</format>
<instructions>Stay strictly in {{char}}'s limited point of view and voice. Write in plain everyday language, the way a real person writes in a private diary, not literary or flowery prose. Never use em dashes or en dashes in any form (—, –, or --); use commas, periods, or parentheses instead. Return plain unformatted text only, no markdown.</instructions>`;
const DEFAULT_PRESET = { id: 'preset-default-summarize', name: 'Rolling Summary', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, profile: null, rateLimit: 0 };
const WRITER_DIARY_PRESET = { id: 'preset-writer-diary', name: "Writer's Diary (3rd person limited)", systemPrompt: WRITER_DIARY_SYSTEM, userPrompt: DIARY_USER_PROMPT, profile: null, rateLimit: 0 };
const CHARACTER_DIARY_PRESET = { id: 'preset-character-diary', name: "Character's Diary (1st person)", systemPrompt: CHARACTER_DIARY_SYSTEM, userPrompt: DIARY_USER_PROMPT, profile: null, rateLimit: 0 };
const defaults = {
    is_enabled: true, show_buttons: [Buttons.STOP], memory_system_prompt: SYSTEM_PROMPT,
    memory_prompt_template: USER_PROMPT, rate_limit: 0, profile: null, hide_chapter: true,
    add_chunk_summaries: false, use_chunk_summaries_as_chapter: false, archive_on_accept: true,
    auto_accept_end: false, auto_stock_chunks: false, stock_profile: null, stock_context_limit: 0,
    merge_use_stock: true, merge_ignore_previous: false, use_archive_as_regen_base: true,
    chunk_system_prompt: CHUNK_SYSTEM_PROMPT, chunk_prompt_template: CHUNK_USER_PROMPT, use_custom_chunk_prompts: false,
    summarize_presets: [DEFAULT_PRESET, WRITER_DIARY_PRESET, CHARACTER_DIARY_PRESET], current_summarize_preset: DEFAULT_PRESET.id,
    inject_enabled: false, inject_depth: 0, inject_role: extension_prompt_roles.SYSTEM,
    inject_prompt: INJECT_PROMPT, rolling_settings_migrated: true, locale_override: 'auto',
};
const obsolete = ['tools_enabled','quick_reply_buttons_location','quick_reply_buttons_enabled','loading_screen_enabled','chapter_query_system_prompt','chapter_query_prompt_template','timeline_fill_system_prompt','timeline_fill_prompt_template','query_chapter_limit','timeline_fill_query_limit','query_profile','timeline_fill_profile','query_presets','current_query_preset','timeline_fill_presets','current_timeline_fill_preset','agentic_timeline_fill_enabled','agentic_timeline_fill_profile','agentic_timeline_fill_prompt','chapter_end_mode','scene_end_mode','hide_scene'];
const clone = value => JSON.parse(JSON.stringify(value));
const escapeHtml = text => $('<div>').text(String(text ?? '')).html();
const save = () => getContext().saveSettingsDebounced();

function migrate(value) {
    let changed = false;
    if (value.hide_scene !== undefined && value.hide_chapter === undefined) value.hide_chapter = value.hide_scene;
    if (!value.rolling_settings_migrated) {
        if (!value.memory_prompt_template || /{{timeline}}/i.test(value.memory_prompt_template)) value.memory_prompt_template = USER_PROMPT;
        if (!value.memory_system_prompt || /timeline database|scene summarization/i.test(value.memory_system_prompt)) value.memory_system_prompt = SYSTEM_PROMPT;
        if (!value.inject_prompt || /{{timeline|timelineResponses/i.test(value.inject_prompt)) value.inject_prompt = INJECT_PROMPT;
        if (Array.isArray(value.summarize_presets)) value.summarize_presets = value.summarize_presets.map(preset => ({ ...preset, userPrompt: /{{timeline}}/i.test(preset?.userPrompt || '') ? USER_PROMPT : (preset?.userPrompt || USER_PROMPT), systemPrompt: preset?.systemPrompt || SYSTEM_PROMPT }));
        value.rolling_settings_migrated = true; changed = true;
    }
    for (const key of obsolete) if (key in value) { delete value[key]; changed = true; }
    for (const [key, fallback] of Object.entries(defaults)) if (value[key] == null || value[key] === 'undefined') { value[key] = clone(fallback); changed = true; }
    value.show_buttons = Array.isArray(value.show_buttons) ? value.show_buttons.filter(item => item === Buttons.STOP) : [Buttons.STOP];
    if (!Array.isArray(value.summarize_presets) || !value.summarize_presets.length) value.summarize_presets = [clone(DEFAULT_PRESET)];
    for (const builtin of [WRITER_DIARY_PRESET, CHARACTER_DIARY_PRESET]) {
        const existing = value.summarize_presets.find(preset => preset?.id === builtin.id);
        if (!existing) { value.summarize_presets.push(clone(builtin)); changed = true; }
        else if (existing.systemPrompt !== builtin.systemPrompt || existing.userPrompt !== builtin.userPrompt) { existing.systemPrompt = builtin.systemPrompt; existing.userPrompt = builtin.userPrompt; changed = true; }
    }
    return changed;
}

export async function loadSettings() {
    settings = extension_settings[extension_name] || {};
    extension_settings[extension_name] = settings;
    if (migrate(settings)) save();
    await setExtensionLocale(settings.locale_override);
    await loadUI();
}
export function changeCharaName() {}

async function updateInjection() { (await import('./memories.js')).updateSummaryInjection(); }
function populateProfiles() {
    for (const [id, key] of [['#rmr_profile', 'profile'], ['#rmr_stock_profile', 'stock_profile']]) {
        const select = $(id); select.find('option:not(:first)').remove();
        for (const profile of extension_settings.connectionManager?.profiles || []) select.append($('<option>').val(profile.id).text(profile.name));
        select.val(settings[key] || '');
    }
}

async function loadVersionBadge() {
    try {
        const response = await fetch(getExtensionAssetPath('manifest.json'));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const version = String((await response.json()).version || '').trim();
        $('#rmr_version_badge').text(version ? `v${version}` : '').prop('hidden', !version);
    } catch (error) { debug('Could not load extension version:', error); $('#rmr_version_badge').prop('hidden', true); }
}
async function changeLocale(value) {
    settings.locale_override = value || 'auto';
    save();
    await setExtensionLocale(settings.locale_override);
    applyExtensionLocale($('#rmr_settings_root'));
    await renderActiveSummary();
    await renderArchiveList();
    refreshTutorialLocale();
}
function initInfoTooltips() {
    let tip = document.getElementById('rmr_info_tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'rmr_info_tooltip';
        tip.className = 'rmr-info-tooltip';
        document.body.appendChild(tip);
    }
    const hide = () => tip.classList.remove('rmr-info-show');
    $('#rmr_settings_root').off('.fttTip')
        .on('mouseenter.fttTip focusin.fttTip', '.rmr-info-icon', function () {
            const text = this.getAttribute('data-tip');
            if (!text) return;
            tip.textContent = text;
            tip.classList.add('rmr-info-show');
        })
        .on('mouseleave.fttTip focusout.fttTip', '.rmr-info-icon', hide);
    $(document).off('keydown.fttTip').on('keydown.fttTip', e => { if (e.key === 'Escape') hide(); });
}
async function loadUI() {
    if (!$('#rmr_settings_root').length) $('#extensions_settings').append(await $.get(getExtensionAssetPath('templates/settings_panel.html')));
    if (!$('#rmr_summary_popup').length) $('body').append('<div id="rmr_summary_popup" class="rmr-summary-popup-overlay" style="display:none"><div class="rmr-summary-popup"><div class="rmr-summary-popup-header"><span id="rmr_popup_title" class="rmr-summary-popup-title">Rolling Summary</span><span id="rmr_popup_range" class="rmr-summary-popup-range"></span><button type="button" id="rmr_popup_close" class="rmr-summary-popup-close"><i class="fa-solid fa-xmark"></i></button></div><div class="rmr-summary-popup-body"><textarea id="rmr_popup_textarea" class="rmr-summary-popup-textarea text_pole" placeholder="Summary..."></textarea></div><div class="rmr-summary-popup-footer"><label id="rmr_popup_archive_wrap" class="checkbox_label"><input id="rmr_popup_archive_old" class="checkbox" type="checkbox"> <span data-i18n="rmr_archive_previous">Archive previous summary</span></label><div class="rmr-summary-popup-spacer"></div><button type="button" class="menu_button" id="rmr_popup_resummarize" data-i18n="rmr_resummarize">Re-summarize</button><button type="button" class="menu_button" id="rmr_popup_cancel" data-i18n="rmr_cancel">Cancel</button><button type="button" class="menu_button" id="rmr_popup_save" data-i18n="rmr_accept">Accept</button></div></div></div>');
    applyExtensionLocale($('#rmr_settings_root'));
    initInfoTooltips();
    await loadVersionBadge();
    const localeSelect = $('#rmr_language_select').empty();
    for (const locale of getAvailableLocales()) localeSelect.append($('<option>').val(locale.code).text(locale.name));
    localeSelect.val(settings.locale_override || 'auto').off('change').on('change', function () { changeLocale(this.value); });
    $('#rmr_memory_system_prompt').val(settings.memory_system_prompt).attr('placeholder', SYSTEM_PROMPT);
    $('#rmr_memory_prompt_template').val(settings.memory_prompt_template).attr('placeholder', USER_PROMPT);
    $('#rmr_chunk_system_prompt').val(settings.chunk_system_prompt).attr('placeholder', CHUNK_SYSTEM_PROMPT);
    $('#rmr_chunk_prompt_template').val(settings.chunk_prompt_template).attr('placeholder', CHUNK_USER_PROMPT);
    $('#rmr_inject_prompt').val(settings.inject_prompt).attr('placeholder', INJECT_PROMPT);
    $('#rmr_chapter_button').prop('checked', settings.show_buttons.includes(Buttons.STOP)).off('change').on('change', function () { settings.show_buttons = this.checked ? [Buttons.STOP] : []; save(); resetMessageButtons(); });
    for (const key of ['hide_chapter','add_chunk_summaries','use_chunk_summaries_as_chapter','archive_on_accept','auto_accept_end','use_archive_as_regen_base','merge_use_stock','merge_ignore_previous']) $(`#rmr_${key}`).prop('checked', !!settings[key]).off('change').on('change', function () { settings[key] = this.checked; save(); });
    $('#rmr_auto_stock_chunks').prop('checked', !!settings.auto_stock_chunks).off('change').on('change', async function () {
        settings.auto_stock_chunks = this.checked; save();
        if (this.checked) { const { autoStockChunks } = await import('./memories.js'); autoStockChunks({ verbose: true }); }
    });
    $('#rmr_stock_now').off('click').on('click', async function () {
        const button = $(this);
        if (button.prop('disabled')) return;
        button.prop('disabled', true);
        try {
            const { autoStockChunks } = await import('./memories.js');
            await autoStockChunks({ force: true, verbose: true });
        } finally { button.prop('disabled', false); }
    });
    $('#rmr_clear_stock').off('click').on('click', async function () {
        if (!confirm(getText('rmr_clear_stock_confirm', 'Delete all stocked chunk summaries for this chat?'))) return;
        const { clearStockedChunks } = await import('./memories.js');
        await clearStockedChunks();
    });
    $('#rmr_view_stock').off('click').on('click', () => openStockViewer());
    $('#rmr_restock').off('click').on('click', async function () {
        if (!confirm(getText('rmr_restock_confirm', 'Discard the unmerged stocked chunks and stock again from the active summary?'))) return;
        const button = $(this);
        if (button.prop('disabled')) return;
        button.prop('disabled', true);
        try {
            const { restockChunks } = await import('./memories.js');
            await restockChunks();
        } finally { button.prop('disabled', false); }
    });
    $('#rmr_rate_limit').val(settings.rate_limit).off('change').on('change', function () { settings.rate_limit = Math.max(0, Number(this.value) || 0); this.value = settings.rate_limit; save(); });
    populateProfiles(); $('#rmr_profile').off('change').on('change', function () { settings.profile = this.value || null; save(); });
    $('#rmr_stock_profile').off('change').on('change', function () { settings.stock_profile = this.value || null; save(); });
    $('#rmr_stock_context_limit').val(settings.stock_context_limit || '').off('change').on('change', function () { settings.stock_context_limit = Math.max(0, Number(this.value) || 0); this.value = settings.stock_context_limit || ''; save(); renderStockStatus(); });
    $('#rmr_inject_enabled').prop('checked', settings.inject_enabled).off('change').on('change', async function () { settings.inject_enabled = this.checked; save(); await updateInjection(); });
    $('#rmr_inject_depth').val(settings.inject_depth).off('change').on('change', async function () { settings.inject_depth = Math.max(0, Number(this.value) || 0); save(); await updateInjection(); });
    const roles = $('#rmr_inject_role').empty();
    for (const [name, role] of Object.entries(extension_prompt_roles)) roles.append($('<option>').val(role).text(name[0] + name.slice(1).toLowerCase()));
    roles.val(settings.inject_role).off('change').on('change', async function () { settings.inject_role = Number(this.value); save(); await updateInjection(); });
    $('#rmr_inject_prompt').off('change').on('change', async function () { settings.inject_prompt = this.value || INJECT_PROMPT; save(); await updateInjection(); });
    $('#rmr_memory_system_prompt').off('change').on('change', function () { settings.memory_system_prompt = this.value || SYSTEM_PROMPT; save(); presetUI(); });
    $('#rmr_memory_prompt_template').off('change').on('change', function () { settings.memory_prompt_template = this.value || USER_PROMPT; save(); presetUI(); });
    $('#rmr_chunk_system_prompt').off('change').on('change', function () { settings.chunk_system_prompt = this.value || CHUNK_SYSTEM_PROMPT; save(); });
    $('#rmr_chunk_prompt_template').off('change').on('change', function () { settings.chunk_prompt_template = this.value || CHUNK_USER_PROMPT; save(); });
    const syncChunkFields = () => $('#rmr_chunk_prompt_fields').toggle(!!settings.use_custom_chunk_prompts);
    $('#rmr_use_custom_chunk_prompts').prop('checked', !!settings.use_custom_chunk_prompts).off('change').on('change', function () { settings.use_custom_chunk_prompts = this.checked; save(); syncChunkFields(); });
    syncChunkFields();
    $('#rmr_create_chapter').off('click').on('click', async function () {
        const button = $(this);
        if (button.prop('disabled')) return;
        const chat = getContext().chat || [];
        if (!chat.length) { toastr.warning('No messages in this chat.', 'IF Memory'); return; }
        const endRaw = $('#rmr_create_chapter_end').val();
        const end = endRaw === '' ? chat.length - 1 : Number(endRaw);
        const stages = Math.max(0, Number($('#rmr_split_stages').val()) || 0);
        const autoAccept = $('#rmr_auto_accept_stages').prop('checked');
        button.prop('disabled', true);
        try {
            const { autoSplitSummarize } = await import('./memories.js');
            await autoSplitSummarize(end, stages, {
                autoAcceptIntermediate: autoAccept,
                useStock: $('#rmr_merge_use_stock').prop('checked'),
                ignorePrevious: $('#rmr_merge_ignore_previous').prop('checked'),
            });
        } finally { button.prop('disabled', false); }
    });
    $('#rmr_resume_checkpoint').off('click').on('click', async function () {
        const button = $(this);
        if (button.prop('disabled')) return;
        button.prop('disabled', true);
        try {
            const { resumePendingCheckpoint } = await import('./memories.js');
            await resumePendingCheckpoint();
        } finally { button.prop('disabled', false); renderPendingCheckpoint(); }
    });
    $('#rmr_discard_checkpoint').off('click').on('click', async function () {
        if (!confirm(getText('rmr_discard_checkpoint_confirm', 'Discard the saved chapter progress?'))) return;
        const { discardPendingCheckpoint } = await import('./memories.js');
        await discardPendingCheckpoint();
    });
    $('#rmr_archive_isolate').off('click').on('click', async function () {
        const { isArchiveIsolated, setArchiveIsolated } = await import('./memories.js');
        await setArchiveIsolated(!isArchiveIsolated());
    });
    $('#rmr_archive_clear').off('click').on('click', async function () {
        if (!confirm(getText('rmr_archive_clear_confirm', 'Permanently delete every archived summary of this chat?'))) return;
        const { clearArchiveEntries } = await import('./memories.js');
        await clearArchiveEntries();
    });
    bindPresets(); $('#rmr_master_export').off('click').on('click', exportConfig); $('#rmr_master_import').off('click').on('click', importConfig);
    initTutorialUI(); await renderActiveSummary(); await renderArchiveList(); renderPendingCheckpoint(); renderStockStatus(); debug('Rolling summary UI loaded');
}

function renderStockMiniBar(state) {
    let bar = $('#rmr_stock_minibar');
    if (!state) { bar.hide(); return; }
    if (!bar.length) {
        const anchor = $('#send_form');
        if (!anchor.length) return;
        bar = $('<div id="rmr_stock_minibar" title=""><div id="rmr_stock_minibar_fill"></div></div>');
        anchor.before(bar);
    }
    const { total, maxContext, percent, stocking } = state;
    bar.attr('title', `IF Memory · ${getText('rmr_stock_tokens', 'Stocked summary size')}: ${total} / ${maxContext} ${getText('rmr_tokens', 'tokens')} (~${percent}%)${stocking ? ` · ${getText('rmr_stocking_now', 'Stocking in background...')}` : ''}`);
    bar.toggleClass('rmr-stocking', !!stocking).show();
    $('#rmr_stock_minibar_fill').css('width', `${Math.max(2, percent)}%`);
}

export async function renderStockStatus() {
    const box = $('#rmr_stock_status'); if (!box.length) return;
    try {
        const { getStockedChunks, isStocking, getRollingSummary, getStockContextLimit } = await import('./memories.js');
        const entries = getStockedChunks();
        const stocking = isStocking();
        const activeEnd = getRollingSummary()?.endMsgId ?? -1;
        const pending = entries.filter(entry => entry.fromMsgId > activeEnd);
        $('#rmr_clear_stock').toggle(entries.length > 0);
        $('#rmr_view_stock').toggle(entries.length > 0);
        $('#rmr_restock').toggle(pending.length > 0 && !stocking);
        if (!entries.length && !stocking) { box.hide(); renderStockMiniBar(null); return; }
        const parts = [];
        if (entries.length) parts.push(`${entries.length} ${getText('rmr_stocked_chunks', 'stocked chunks')}`);
        if (pending.length) parts.push(`${getText('rmr_stock_from', 'from message')} ${pending[0].fromMsgId}`);
        else if (entries.length) parts.push(getText('rmr_stock_all_merged', 'all already merged into the active summary'));
        if (stocking) parts.push(getText('rmr_stocking_now', 'Stocking in background...'));
        $('#rmr_stock_status_text').text(parts.join(' · '));
        const ranges = $('#rmr_stock_ranges').empty();
        if (pending.length) {
            ranges.append($('<small class="rmr-stock-ranges-hint">').text(getText('rmr_stock_ranges_hint', 'Click a merge point to set it as the End ID:')));
            for (const entry of pending) {
                ranges.append($('<button type="button" class="rmr-stock-range" title="Set End Message ID">')
                    .text(entry.toMsgId)
                    .on('click', () => {
                        $('#rmr_create_chapter_end').val(entry.toMsgId);
                        toastr.info(`${getText('rmr_end_id_set', 'End Message ID set to')} ${entry.toMsgId}`, 'IF Memory');
                    }));
            }
        }
        ranges.toggle(pending.length > 0);
        const tokensBox = $('#rmr_stock_tokens');
        if (pending.length) {
            const total = await countTokens(pending.map(entry => entry.summary).join('\n\n'));
            const maxContext = Math.max(1, getStockContextLimit());
            const percent = Math.min(100, Math.round((total / maxContext) * 100));
            $('#rmr_stock_tokens_text').text(`${getText('rmr_stock_tokens', 'Stocked summary size')}: ${total} / ${maxContext} ${getText('rmr_tokens', 'tokens')} (~${percent}%)`);
            $('#rmr_stock_tokens_fill').css('width', `${Math.max(2, percent)}%`).attr('title', `${percent}%`);
            tokensBox.show();
            renderStockMiniBar({ total, maxContext, percent, stocking });
        } else { tokensBox.hide(); renderStockMiniBar(stocking ? { total: 0, maxContext: 1, percent: 0, stocking } : null); }
        box.css('display', 'flex');
    } catch (error) { debug('Could not render stock status:', error); box.hide(); renderStockMiniBar(null); }
}

export async function openStockViewer() {
    const { getStockedChunks, getRollingSummary, regenerateStockedChunk, deleteStockedChunk } = await import('./memories.js');
    $('#rmr_stock_viewer').remove();
    const overlay = $('<div id="rmr_stock_viewer" class="rmr-summary-popup-overlay"></div>');
    const dialog = $('<div class="rmr-summary-popup"></div>');
    const header = $(`<div class="rmr-summary-popup-header"><span class="rmr-summary-popup-title">${escapeHtml(getText('rmr_stock_viewer_title', 'Stocked chunk summaries'))}</span><span class="rmr-summary-popup-spacer"></span><button type="button" class="menu_button rmr-stock-delete-merged">${escapeHtml(getText('rmr_stock_delete_merged', 'Delete merged'))}</button><button type="button" class="menu_button rmr-stock-delete-all">${escapeHtml(getText('rmr_stock_delete_all', 'Delete all'))}</button><button type="button" class="rmr-summary-popup-close"><i class="fa-solid fa-xmark"></i></button></div>`);
    const body = $('<div class="rmr-summary-popup-body rmr-stock-viewer-body"></div>');
    dialog.append(header, body);
    overlay.append(dialog);
    $('body').append(overlay);
    const close = () => { $(document).off('keydown.fttStock'); overlay.remove(); };
    header.find('.rmr-summary-popup-close').on('click', close);
    header.find('.rmr-stock-delete-all').on('click', async () => {
        if (!confirm(getText('rmr_stock_delete_all_confirm', 'Delete ALL stocked chunk summaries of this chat?'))) return;
        const { clearStockedChunks } = await import('./memories.js');
        await clearStockedChunks(); await rebuild();
    });
    header.find('.rmr-stock-delete-merged').on('click', async () => {
        const { clearMergedStockedChunks, getRollingSummary } = await import('./memories.js');
        const removed = await clearMergedStockedChunks(getRollingSummary()?.endMsgId ?? -1);
        toastr.info(`${removed} merged chunk(s) removed.`, 'IF Memory');
        await rebuild();
    });
    overlay.on('click', event => { if (event.target === overlay[0]) close(); });
    $(document).off('keydown.fttStock').on('keydown.fttStock', event => { if (event.key === 'Escape') close(); });
    const rebuild = async () => {
        body.empty();
        const entries = getStockedChunks();
        const activeEnd = getRollingSummary()?.endMsgId ?? -1;
        if (!entries.length) { body.append($('<div class="rmr-summaries-empty">').text(getText('rmr_stock_empty', 'No stocked chunks yet.'))); return; }
        for (const entry of entries) {
            const merged = entry.toMsgId <= activeEnd;
            const badge = merged ? getText('rmr_stock_merged', 'merged') : getText('rmr_stock_pending', 'pending');
            const tokens = await countTokens(entry.summary);
            const item = $(`<details class="rmr-archive-item rmr-stock-item${merged ? ' rmr-stock-item-merged' : ''}"><summary>#${entry.fromMsgId}–${entry.toMsgId} · ${tokens} ${escapeHtml(getText('rmr_tokens', 'tokens'))} · <span class="rmr-stock-badge">${escapeHtml(badge)}</span> · ${escapeHtml(new Date(entry.createdAt).toLocaleString())}</summary><pre></pre><div class="rmr-summary-actions"><button type="button" class="menu_button rmr-stock-regen"><i class="fa-solid fa-rotate"></i> ${escapeHtml(getText('rmr_regenerate', 'Regenerate'))}</button><button type="button" class="menu_button rmr-stock-delete"><i class="fa-solid fa-trash-can"></i> ${escapeHtml(getText('rmr_delete', 'Delete'))}</button></div></details>`);
            item.find('pre').text(entry.summary);
            item.find('.rmr-stock-regen').on('click', async function () {
                const button = $(this);
                if (button.prop('disabled')) return;
                button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
                try { await regenerateStockedChunk(entry.fromMsgId, entry.toMsgId); }
                finally { if (overlay.closest('body').length) await rebuild(); }
            });
            item.find('.rmr-stock-delete').on('click', async () => {
                if (!confirm(getText('rmr_delete_stock_confirm', 'Delete this stocked chunk summary?'))) return;
                await deleteStockedChunk(entry.fromMsgId, entry.toMsgId);
                await rebuild();
            });
            body.append(item);
        }
    };
    await rebuild();
}

export function updateChapterProgress(state) {
    const box = $('#rmr_chapter_progress'); if (!box.length) return;
    if (!state) { box.hide(); $('#rmr_chapter_progress_fill').css('width', '0%'); renderPendingCheckpoint(); return; }
    const { phase, current = 0, total = 0, stage, profile } = state;
    const stageText = stage?.total > 1 ? `${getText('rmr_stage', 'Stage')} ${stage.current}/${stage.total} — ` : '';
    let text, percent;
    if (phase === 'final') {
        text = `${stageText}${getText('rmr_progress_final', 'Merging into final summary...')}`;
        percent = 100;
    } else {
        text = `${stageText}${getText('rmr_progress_chunk', 'Chunk')} ${Math.min(current + 1, total)}/${total}`;
        percent = total ? Math.round((current / total) * 100) : 0;
    }
    $('#rmr_chapter_progress_text').text(profile ? `${text} \u00b7 ${profile}` : text);
    $('#rmr_chapter_progress_fill').css('width', `${percent}%`);
    box.css('display', 'flex');
    renderPendingCheckpoint();
}

export async function renderPendingCheckpoint() {
    const box = $('#rmr_pending_checkpoint'); if (!box.length) return;
    try {
        const { getPendingCheckpoint } = await import('./memories.js');
        const pending = getPendingCheckpoint();
        const generating = $('#rmr_chapter_progress').is(':visible');
        if (!pending || generating) { box.hide(); return; }
        const when = pending.updatedAt ? ` · ${new Date(pending.updatedAt).toLocaleString()}` : '';
        $('#rmr_pending_checkpoint_text').text(`${getText('rmr_pending_checkpoint', 'Unfinished chapter')}: ${pending.chunksDone}/${pending.chunkCount} ${getText('rmr_chunks_done', 'chunks done')} (${getText('rmr_through_message', 'Through message')} ${pending.targetMessageId})${when}`);
        box.css('display', 'flex');
    } catch (error) { debug('Could not render pending checkpoint:', error); box.hide(); }
}

const presetById = id => settings.summarize_presets.find(item => item.id === id);
function presetUI() {
    const select = $('#rmr_summarize_preset'); select.find('option:not([value=""])').remove();
    const current = presetById(settings.current_summarize_preset);
    const dirty = current && (current.systemPrompt !== settings.memory_system_prompt || current.userPrompt !== settings.memory_prompt_template);
    for (const preset of settings.summarize_presets) select.append($('<option>').val(preset.id).text(preset.id === current?.id && dirty ? `${preset.name} *` : preset.name));
    select.val(settings.current_summarize_preset || '');
    $('#rmr_update_summarize_preset,#rmr_delete_summarize_preset,#rmr_export_summarize_preset').prop('disabled', !settings.current_summarize_preset);
}
function applyPreset(id) {
    const preset = presetById(id); if (!preset) return;
    settings.current_summarize_preset = id; settings.memory_system_prompt = preset.systemPrompt; settings.memory_prompt_template = preset.userPrompt;
    if (preset.profile) settings.profile = preset.profile; settings.rate_limit = Number(preset.rateLimit) || 0; save();
    $('#rmr_memory_system_prompt').val(settings.memory_system_prompt); $('#rmr_memory_prompt_template').val(settings.memory_prompt_template); $('#rmr_profile').val(settings.profile || ''); $('#rmr_rate_limit').val(settings.rate_limit);
}
function snapshot(name) { return { id: `preset-${Date.now()}-${Math.floor(Math.random()*1000)}`, name, systemPrompt: settings.memory_system_prompt, userPrompt: settings.memory_prompt_template, profile: settings.profile, rateLimit: settings.rate_limit }; }
function bindPresets() {
    presetUI();
    $('#rmr_summarize_preset').off('change').on('change', function () { if (this.value) applyPreset(this.value); else { settings.current_summarize_preset = null; save(); } presetUI(); });
    $('#rmr_save_summarize_preset').off('click').on('click', () => { const name = prompt('Preset name:'); if (!name?.trim()) return; const duplicate = settings.summarize_presets.find(item => item.name.toLowerCase() === name.trim().toLowerCase()); if (duplicate && !confirm(`Overwrite "${duplicate.name}"?`)) return; const preset = snapshot(name.trim()); if (duplicate) Object.assign(duplicate, preset, {id:duplicate.id}); else settings.summarize_presets.push(preset); settings.current_summarize_preset = duplicate?.id || preset.id; save(); presetUI(); });
    $('#rmr_update_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (!preset) return; Object.assign(preset, snapshot(preset.name), {id:preset.id}); save(); presetUI(); toastr.success('Preset updated.','IF Memory'); });
    $('#rmr_delete_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (!preset || !confirm(`Delete "${preset.name}"?`)) return; settings.summarize_presets = settings.summarize_presets.filter(item => item.id !== preset.id); settings.current_summarize_preset = null; save(); presetUI(); });
    $('#rmr_export_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (preset) download(`${preset.name}.json`, {version:'3.0',type:'summarize',preset}); });
    $('#rmr_import_summarize_preset').off('click').on('click', () => choose(data => { if (data.type !== 'summarize' || !data.preset?.name || !data.preset?.userPrompt) throw new Error('Invalid summarize preset.'); const preset = {...data.preset,id:`preset-${Date.now()}`}; if (/{{timeline}}/i.test(preset.userPrompt)) preset.userPrompt = USER_PROMPT; settings.summarize_presets.push(preset); settings.current_summarize_preset = preset.id; save(); applyPreset(preset.id); presetUI(); }));
}
function download(name,data) { const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a=Object.assign(document.createElement('a'),{href:url,download:name.replace(/[^a-z0-9_.-]/gi,'_')}); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); }
function choose(callback) { const input=Object.assign(document.createElement('input'),{type:'file',accept:'.json'}); input.onchange=async()=>{try{await callback(JSON.parse(await input.files[0].text()));toastr.success('Import complete.','IF Memory');}catch(error){toastr.error(error.message,'IF Memory');}};input.click(); }
function exportConfig() { const output={};for(const key of Object.keys(defaults))output[key]=settings[key];download('fill-the-time-config.json',{version:'3.0',extension:'fill-the-time',settings:output}); }
function importConfig() { choose(async data=>{if(data.extension!=='fill-the-time'||!data.settings)throw new Error('Invalid configuration.');for(const key of Object.keys(defaults))if(data.settings[key]!==undefined)settings[key]=clone(data.settings[key]);settings.rolling_settings_migrated=false;migrate(settings);save();await setExtensionLocale(settings.locale_override);$('#rmr_settings_root').remove();await loadUI();}); }
async function countTokens(text){try{return await getContext().getTokenCountAsync(String(text||''));}catch{return Math.ceil(String(text||'').length/4);}}

export async function renderActiveSummary() {
    const container = $('#rmr_active_summary_container'); if (!container.length) return;
    const { getRollingSummary, updateRollingSummaryText, regenerateActiveSummary } = await import('./memories.js');
    const active = getRollingSummary(); container.empty();
    if (!active) { container.append($('<div class="rmr-summaries-empty">').text(getText('rmr_no_active_summary', 'No active summary. Click ⏹ on a message to create one.'))); return; }
    const tokens = await countTokens(active.summary);
    const card = $(`<div class="rmr-summary-item"><div class="rmr-summary-header"><span>${escapeHtml(getText('rmr_active_summary', 'Active Summary'))}</span><span class="rmr-summary-range">${escapeHtml(getText('rmr_through', 'Through'))} ${active.endMsgId} · ${tokens} ${escapeHtml(getText('rmr_tokens', 'tokens'))}</span><button class="rmr-summary-expand" aria-label="${escapeHtml(getText('rmr_expand', 'Expand'))}"><i class="fa-solid fa-expand"></i></button></div><textarea class="rmr-summary-text text_pole">${escapeHtml(active.summary)}</textarea><div class="rmr-summary-actions"><button class="menu_button rmr-clear-active">${escapeHtml(getText('rmr_clear_restore', 'Clear / Restore'))}</button><button class="menu_button rmr-regenerate-active"><i class="fa-solid fa-rotate"></i>${escapeHtml(getText('rmr_regenerate', 'Regenerate'))}</button><button class="menu_button rmr-save-active" disabled>${escapeHtml(getText('rmr_save', 'Save'))}</button></div></div>`);
    container.append(card);
    const textarea = card.find('textarea');
    textarea.on('input', () => card.find('.rmr-save-active').prop('disabled', textarea.val().trim() === active.summary));
    card.find('.rmr-save-active').on('click', async () => updateRollingSummaryText(textarea.val()));
    card.find('.rmr-clear-active').on('click', showClearOrRestoreDialog);
    card.find('.rmr-regenerate-active').on('click', async function () { const button = $(this), old = button.html(); button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>'); try { await regenerateActiveSummary(); } finally { if (button.closest('body').length) button.prop('disabled', false).html(old); } });
    card.find('.rmr-summary-expand').on('click', () => openEditPopup(active.summary));
}
export async function renderArchiveList() {
    const container = $('#rmr_archive_container'); if (!container.length) return;
    const { getArchiveEntries, deleteArchiveEntry, isArchiveIsolated } = await import('./memories.js'); const entries = getArchiveEntries(); container.empty();
    const isolated = isArchiveIsolated();
    $('#rmr_archive_isolate').html(isolated ? `<i class="fa-solid fa-eye"></i> ${escapeHtml(getText('rmr_archive_show', 'Show archive'))}` : `<i class="fa-solid fa-eye-slash"></i> ${escapeHtml(getText('rmr_archive_hide', 'Hide archive'))}`);
    $('#rmr_archive_clear').toggle(entries.length > 0);
    $('#rmr_archive_state').text(isolated ? `${getText('rmr_archive_hidden_note', 'Archive hidden: it is ignored by merge and regeneration.')} (${entries.length})` : '');
    if (isolated) return;
    if (!entries.length) { container.append($('<div class="rmr-summaries-empty">').text(getText('rmr_archive_empty', 'Archive is empty for this chat.'))); return; }
    entries.map((entry, index) => ({ entry, index })).reverse().forEach(({ entry, index }) => {
        const item = $(`<details class="rmr-archive-item"><summary>${escapeHtml(getText('rmr_through', 'Through'))} ${entry.endMsgId} · ${escapeHtml(new Date(entry.archivedAt).toLocaleString())}</summary><pre>${escapeHtml(entry.summary)}</pre><button class="menu_button">${escapeHtml(getText('rmr_delete', 'Delete'))}</button></details>`);
        item.find('button').on('click', async event => { event.preventDefault(); if (confirm(getText('rmr_delete_archive_confirm', 'Delete this archived summary?'))) await deleteArchiveEntry(index); }); container.append(item);
    });
}
function closePopup(resolve,value){$('#rmr_summary_popup').hide().off('.ftt');$('#rmr_popup_close,#rmr_popup_cancel,#rmr_popup_save,#rmr_popup_resummarize').off('.ftt');$(document).off('keydown.ftt');resolve?.(value);}
export function openReviewPopup(proposal,endMsgId,archiveDefault){return new Promise(async resolve=>{const {getRollingSummary,acceptRollingSummary,generateRollingSummary}=await import('./memories.js');const popup=$('#rmr_summary_popup'),textarea=$('#rmr_popup_textarea'),accept=$('#rmr_popup_save');$('#rmr_popup_title').text(getText('rmr_review_summary','Review Rolling Summary'));$('#rmr_popup_range').text(`${getText('rmr_through_message','Through message')} ${endMsgId}`);textarea.val(proposal);accept.text(getText('rmr_accept','Accept')).prop('disabled',false);$('#rmr_popup_cancel').text(getText('rmr_cancel','Cancel'));$('#rmr_popup_resummarize').show().text(getText('rmr_resummarize','Re-summarize'));const hasOld=!!getRollingSummary();$('#rmr_popup_archive_wrap').toggle(hasOld);$('#rmr_popup_archive_old').prop('checked',archiveDefault===undefined?settings.archive_on_accept:!!archiveDefault);popup.css('display','flex');const cancel=()=>closePopup(resolve,false);$('#rmr_popup_cancel,#rmr_popup_close').off('.ftt').on('click.ftt',cancel);popup.off('.ftt').on('click.ftt',event=>{if(event.target===popup[0])cancel();});$(document).off('keydown.ftt').on('keydown.ftt',event=>{if(event.key==='Escape')cancel();});accept.off('.ftt').on('click.ftt',async()=>{const text=textarea.val().trim();if(!text){toastr.warning(getText('rmr_summary_empty','Summary cannot be empty.'),'IF Memory');return;}accept.prop('disabled',true);if(await acceptRollingSummary(text,endMsgId,hasOld&&$('#rmr_popup_archive_old').prop('checked')))closePopup(resolve,true);else accept.prop('disabled',false);});$('#rmr_popup_resummarize').off('.ftt').on('click.ftt',async function(){const button=$(this),old=button.html();button.prop('disabled',true).html('<i class="fa-solid fa-spinner fa-spin"></i>');try{const result=await generateRollingSummary(endMsgId);if(result)textarea.val(result);}finally{button.prop('disabled',false).html(old);}});});}
export function openRegenerationPopup(proposal, endMsgId) {
    return new Promise(async resolve => {
        const { acceptActiveSummaryReplacement, generateActiveSummaryReplacement } = await import('./memories.js');
        const popup = $('#rmr_summary_popup'), textarea = $('#rmr_popup_textarea'), accept = $('#rmr_popup_save');
        $('#rmr_popup_title').text(getText('rmr_review_regeneration', 'Review Regenerated Summary'));
        $('#rmr_popup_range').text(`${getText('rmr_through_message', 'Through message')} ${endMsgId}`);
        textarea.val(proposal);
        $('#rmr_popup_archive_wrap').hide();
        $('#rmr_popup_resummarize').show().text(getText('rmr_resummarize', 'Re-summarize'));
        $('#rmr_popup_cancel').text(getText('rmr_cancel', 'Cancel'));
        accept.text(getText('rmr_replace', 'Replace')).prop('disabled', false);
        popup.css('display', 'flex');
        const cancel = () => closePopup(resolve, false);
        $('#rmr_popup_cancel,#rmr_popup_close').off('.ftt').on('click.ftt', cancel);
        popup.off('.ftt').on('click.ftt', event => { if (event.target === popup[0]) cancel(); });
        $(document).off('keydown.ftt').on('keydown.ftt', event => { if (event.key === 'Escape') cancel(); });
        accept.off('.ftt').on('click.ftt', async () => {
            const text = textarea.val().trim();
            if (!text) { toastr.warning(getText('rmr_summary_empty', 'Summary cannot be empty.'), 'IF Memory'); return; }
            accept.prop('disabled', true);
            if (await acceptActiveSummaryReplacement(text, endMsgId)) closePopup(resolve, true); else accept.prop('disabled', false);
        });
        $('#rmr_popup_resummarize').off('.ftt').on('click.ftt', async function () {
            const button = $(this), old = button.html(); button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
            try { const result = await generateActiveSummaryReplacement(); if (result) textarea.val(result); }
            finally { button.prop('disabled', false).html(old); }
        });
    });
}
function openEditPopup(text){return new Promise(async resolve=>{const {updateRollingSummaryText}=await import('./memories.js');const popup=$('#rmr_summary_popup'),textarea=$('#rmr_popup_textarea');$('#rmr_popup_title').text('Edit Active Summary');$('#rmr_popup_range').text('');textarea.val(text);$('#rmr_popup_archive_wrap,#rmr_popup_resummarize').hide();$('#rmr_popup_save').text('Save').prop('disabled',false);popup.css('display','flex');const cancel=()=>closePopup(resolve,false);$('#rmr_popup_cancel,#rmr_popup_close').off('.ftt').on('click.ftt',cancel);popup.off('.ftt').on('click.ftt',event=>{if(event.target===popup[0])cancel();});$(document).off('keydown.ftt').on('keydown.ftt',event=>{if(event.key==='Escape')cancel();});$('#rmr_popup_save').off('.ftt').on('click.ftt',async()=>{const value=textarea.val().trim();if(value&&await updateRollingSummaryText(value))closePopup(resolve,true);});});}
export async function showClearOrRestoreDialog() {
    const { getRollingSummary, getArchiveEntries, isArchiveIsolated, restorePreviousFromArchive, clearRollingSummary } = await import('./memories.js');
    if (!getRollingSummary()) { toastr.info('No active summary.', 'IF Memory'); return false; }
    const isolated = isArchiveIsolated();
    const canRestore = getArchiveEntries().length > 0 && !isolated;
    return new Promise(resolve => {
        const overlay = $(`<div class="rmr-choice-overlay"><div class="rmr-choice-dialog"><h3>${escapeHtml(getText('rmr_change_active', 'Change active summary'))}</h3><p>${escapeHtml(canRestore ? getText('rmr_change_active_hint', 'Restore the newest archive, create empty, or cancel.') : getText('rmr_change_active_hint_none', 'No usable archive (empty or hidden). Create empty or cancel.'))}</p><label class="checkbox_label"><input type="checkbox" class="checkbox rmr-drop-merged" checked><span>${escapeHtml(getText('rmr_drop_merged_stock', 'Also delete chunks already merged into this summary (recommended)'))}</span></label><label class="checkbox_label"><input type="checkbox" class="checkbox rmr-drop-all"><span>${escapeHtml(getText('rmr_drop_all_stock', 'Delete ALL stocked chunks'))}</span></label><label class="checkbox_label"><input type="checkbox" class="checkbox rmr-drop-archive"><span>${escapeHtml(getText('rmr_drop_archive', 'Also delete this chat archive'))}</span></label><div class="rmr-choice-actions">${canRestore ? `<button class="menu_button restore">${escapeHtml(getText('rmr_restore_latest', 'Restore latest'))}</button>` : ''}<button class="menu_button empty">${escapeHtml(getText('rmr_create_empty', 'Create empty'))}</button><button class="menu_button cancel">${escapeHtml(getText('rmr_cancel', 'Cancel'))}</button></div></div></div>`);
        $('body').append(overlay);
        let settled = false;
        const finish = value => { if (settled) return; settled = true; $(document).off('keydown.fttChoice'); overlay.remove(); resolve(value); };
        overlay.find('.cancel').on('click', () => finish(false));
        overlay.on('click', event => { if (event.target === overlay[0]) finish(false); });
        $(document).off('keydown.fttChoice').on('keydown.fttChoice', event => { if (event.key === 'Escape') finish(false); });
        overlay.find('.restore').on('click', async () => finish(await restorePreviousFromArchive()));
        overlay.find('.empty').on('click', async () => finish(await clearRollingSummary({
            dropMergedStock: overlay.find('.rmr-drop-merged').prop('checked'),
            dropAllStock: overlay.find('.rmr-drop-all').prop('checked'),
            dropArchive: overlay.find('.rmr-drop-archive').prop('checked'),
        })));
    });
}
