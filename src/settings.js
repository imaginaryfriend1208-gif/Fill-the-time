import { extension_settings, getContext } from '../../../../extensions.js';
import { extension_prompt_roles } from '../../../../../script.js';
import { extension_name, getExtensionAssetPath } from '../index.js';
import { resetMessageButtons } from './messages.js';
import { debug } from './logging.js';
import { initTutorialUI } from './tutorial.js';
import { applyExtensionLocale } from './locales.js';

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

Return one plaintext block without markdown.

The updated diary is:`;
const WRITER_DIARY_SYSTEM = `<role>You are the story's writer, keeping a private development diary about an ongoing story. You write in third person limited: every event is recorded strictly through what each character personally knows, saw, or believes at that time. Never leak one character's secret knowledge into another character's understanding.</role>
<task>Merge the previous diary and the newest events into ONE updated development diary, written in the same language the story is written in.</task>
<format>
Write the diary with these sections:
[CHRONICLE] Dated diary entries of ALL events so far, oldest first. Whenever the story states or implies a date, time, day of week, season, or elapsed time, record it explicitly (e.g. "Day 12, evening", "Sunday, March 3rd"). Mark anniversaries, birthdays, promises, and memorable firsts with (REMEMBER: ...) so they can be celebrated or called back later. You may add short asides in parentheses, like (NOTE: ...) for writer observations about a character or (PLAN: ...) for ideas on where to take them. Compress older entries more than recent ones, but never delete a recorded event or a REMEMBER note unless newer events supersede them.
[WHO KNOWS WHAT] For each major character: what they currently know, believe (possibly wrongly), and still do not know.
[OPEN THREADS & PLAN] Every unresolved or open thread: what was set up, what is still owed to the reader, and a short concrete plan for how it could be developed or paid off later.
</format>
<instructions>Preserve critical plot developments, character changes, relationships, resolved conflicts, and unresolved threads. Exclude minor description and dialogue excerpts. Write in plain everyday language, like quick working notes, not literary or flowery prose. Never use em dashes or en dashes in any form (—, –, or --); use commas, periods, or parentheses instead. Return plain unformatted text only, no markdown.</instructions>`;
const CHARACTER_DIARY_SYSTEM = `<role>You are {{char}}, privately writing in your personal diary at the end of the most recent scene. Write in first person, in {{char}}'s authentic voice, in the same language the story is written in. You only know what {{char}} personally witnessed, was told, or believes — you may be wrong about things, and you must not mention anything {{char}} could not know.</role>
<task>Rewrite your diary by merging the previous diary with what just happened, into ONE updated diary.</task>
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
    summarize_presets: [DEFAULT_PRESET, WRITER_DIARY_PRESET, CHARACTER_DIARY_PRESET], current_summarize_preset: DEFAULT_PRESET.id,
    inject_enabled: false, inject_depth: 0, inject_role: extension_prompt_roles.SYSTEM,
    inject_prompt: INJECT_PROMPT, rolling_settings_migrated: true,
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
    await loadUI();
}
export function changeCharaName() {}

async function updateInjection() { (await import('./memories.js')).updateSummaryInjection(); }
function populateProfiles() {
    const select = $('#rmr_profile'); select.find('option:not(:first)').remove();
    for (const profile of extension_settings.connectionManager?.profiles || []) select.append($('<option>').val(profile.id).text(profile.name));
    select.val(settings.profile || '');
}

async function loadUI() {
    if (!$('#rmr_settings_root').length) { $('#extensions_settings').append(await $.get(getExtensionAssetPath('templates/settings_panel.html'))); applyExtensionLocale($('#rmr_settings_root')); }
    $('#rmr_memory_system_prompt').val(settings.memory_system_prompt).attr('placeholder', SYSTEM_PROMPT);
    $('#rmr_memory_prompt_template').val(settings.memory_prompt_template).attr('placeholder', USER_PROMPT);
    $('#rmr_inject_prompt').val(settings.inject_prompt).attr('placeholder', INJECT_PROMPT);
    $('#rmr_chapter_button').prop('checked', settings.show_buttons.includes(Buttons.STOP)).off('change').on('change', function () { settings.show_buttons = this.checked ? [Buttons.STOP] : []; save(); resetMessageButtons(); });
    for (const key of ['hide_chapter','add_chunk_summaries','use_chunk_summaries_as_chapter','archive_on_accept']) $(`#rmr_${key}`).prop('checked', !!settings[key]).off('change').on('change', function () { settings[key] = this.checked; save(); });
    $('#rmr_rate_limit').val(settings.rate_limit).off('change').on('change', function () { settings.rate_limit = Math.max(0, Number(this.value) || 0); this.value = settings.rate_limit; save(); });
    populateProfiles(); $('#rmr_profile').off('change').on('change', function () { settings.profile = this.value || null; save(); });
    $('#rmr_inject_enabled').prop('checked', settings.inject_enabled).off('change').on('change', async function () { settings.inject_enabled = this.checked; save(); await updateInjection(); });
    $('#rmr_inject_depth').val(settings.inject_depth).off('change').on('change', async function () { settings.inject_depth = Math.max(0, Number(this.value) || 0); save(); await updateInjection(); });
    const roles = $('#rmr_inject_role').empty();
    for (const [name, role] of Object.entries(extension_prompt_roles)) roles.append($('<option>').val(role).text(name[0] + name.slice(1).toLowerCase()));
    roles.val(settings.inject_role).off('change').on('change', async function () { settings.inject_role = Number(this.value); save(); await updateInjection(); });
    $('#rmr_inject_prompt').off('change').on('change', async function () { settings.inject_prompt = this.value || INJECT_PROMPT; save(); await updateInjection(); });
    $('#rmr_memory_system_prompt').off('change').on('change', function () { settings.memory_system_prompt = this.value || SYSTEM_PROMPT; settings.current_summarize_preset = null; save(); presetUI(); });
    $('#rmr_memory_prompt_template').off('change').on('change', function () { settings.memory_prompt_template = this.value || USER_PROMPT; settings.current_summarize_preset = null; save(); presetUI(); });
    $('#rmr_create_chapter').off('click').on('click', async function () {
        const button = $(this);
        if (button.prop('disabled')) return;
        const chat = getContext().chat || [];
        if (!chat.length) { toastr.warning('No messages in this chat.', 'Fill the Time'); return; }
        const endRaw = $('#rmr_create_chapter_end').val();
        const end = endRaw === '' ? chat.length - 1 : Number(endRaw);
        const stages = Math.max(0, Number($('#rmr_split_stages').val()) || 0);
        const autoAccept = $('#rmr_auto_accept_stages').prop('checked');
        button.prop('disabled', true);
        try {
            const { autoSplitSummarize } = await import('./memories.js');
            await autoSplitSummarize(end, stages, { autoAcceptIntermediate: autoAccept });
        } finally { button.prop('disabled', false); }
    });
    bindPresets(); $('#rmr_master_export').off('click').on('click', exportConfig); $('#rmr_master_import').off('click').on('click', importConfig);
    initTutorialUI(); await renderActiveSummary(); await renderArchiveList(); debug('Rolling summary UI loaded');
}

const presetById = id => settings.summarize_presets.find(item => item.id === id);
function presetUI() {
    const select = $('#rmr_summarize_preset'); select.find('option:not([value=""])').remove();
    for (const preset of settings.summarize_presets) select.append($('<option>').val(preset.id).text(preset.name));
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
    $('#rmr_update_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (!preset) return; Object.assign(preset, snapshot(preset.name), {id:preset.id}); save(); toastr.success('Preset updated.','Fill the Time'); });
    $('#rmr_delete_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (!preset || !confirm(`Delete "${preset.name}"?`)) return; settings.summarize_presets = settings.summarize_presets.filter(item => item.id !== preset.id); settings.current_summarize_preset = null; save(); presetUI(); });
    $('#rmr_export_summarize_preset').off('click').on('click', () => { const preset = presetById(settings.current_summarize_preset); if (preset) download(`${preset.name}.json`, {version:'3.0',type:'summarize',preset}); });
    $('#rmr_import_summarize_preset').off('click').on('click', () => choose(data => { if (data.type !== 'summarize' || !data.preset?.name || !data.preset?.userPrompt) throw new Error('Invalid summarize preset.'); const preset = {...data.preset,id:`preset-${Date.now()}`}; if (/{{timeline}}/i.test(preset.userPrompt)) preset.userPrompt = USER_PROMPT; settings.summarize_presets.push(preset); settings.current_summarize_preset = preset.id; save(); applyPreset(preset.id); presetUI(); }));
}
function download(name,data) { const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a=Object.assign(document.createElement('a'),{href:url,download:name.replace(/[^a-z0-9_.-]/gi,'_')}); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); }
function choose(callback) { const input=Object.assign(document.createElement('input'),{type:'file',accept:'.json'}); input.onchange=async()=>{try{await callback(JSON.parse(await input.files[0].text()));toastr.success('Import complete.','Fill the Time');}catch(error){toastr.error(error.message,'Fill the Time');}};input.click(); }
function exportConfig() { const output={};for(const key of Object.keys(defaults))output[key]=settings[key];download('fill-the-time-config.json',{version:'3.0',extension:'fill-the-time',settings:output}); }
function importConfig() { choose(async data=>{if(data.extension!=='fill-the-time'||!data.settings)throw new Error('Invalid configuration.');for(const key of Object.keys(defaults))if(data.settings[key]!==undefined)settings[key]=clone(data.settings[key]);settings.rolling_settings_migrated=false;migrate(settings);save();$('#rmr_settings_root').remove();await loadUI();}); }
async function countTokens(text){try{return await getContext().getTokenCountAsync(String(text||''));}catch{return Math.ceil(String(text||'').length/4);}}

export async function renderActiveSummary() {
    const container=$('#rmr_active_summary_container');if(!container.length)return;
    const {getRollingSummary,updateRollingSummaryText}=await import('./memories.js');const active=getRollingSummary();container.empty();
    if(!active){container.append('<div class="rmr-summaries-empty">No active summary. Click ⏹ on a message to create one.</div>');return;}
    const tokens=await countTokens(active.summary);const card=$(`<div class="rmr-summary-item"><div class="rmr-summary-header"><span>Active Summary</span><span class="rmr-summary-range">Through ${active.endMsgId} · ${tokens} tokens</span><button class="rmr-summary-expand"><i class="fa-solid fa-expand"></i></button></div><textarea class="rmr-summary-text text_pole">${escapeHtml(active.summary)}</textarea><div class="rmr-summary-actions"><button class="menu_button rmr-clear-active">Clear / Restore</button><button class="menu_button rmr-save-active" disabled>Save</button></div></div>`);container.append(card);
    const textarea=card.find('textarea');textarea.on('input',()=>card.find('.rmr-save-active').prop('disabled',textarea.val().trim()===active.summary));card.find('.rmr-save-active').on('click',async()=>updateRollingSummaryText(textarea.val()));card.find('.rmr-clear-active').on('click',showClearOrRestoreDialog);card.find('.rmr-summary-expand').on('click',()=>openEditPopup(active.summary));
}
export async function renderArchiveList(){const container=$('#rmr_archive_container');if(!container.length)return;const {getArchiveEntries,deleteArchiveEntry}=await import('./memories.js');const entries=getArchiveEntries();container.empty();if(!entries.length){container.append('<div class="rmr-summaries-empty">Archive is empty for this chat.</div>');return;}entries.map((entry,index)=>({entry,index})).reverse().forEach(({entry,index})=>{const item=$(`<details class="rmr-archive-item"><summary>Through ${entry.endMsgId} · ${escapeHtml(new Date(entry.archivedAt).toLocaleString())}</summary><pre>${escapeHtml(entry.summary)}</pre><button class="menu_button">Delete</button></details>`);item.find('button').on('click',async event=>{event.preventDefault();if(confirm('Delete this archived summary?'))await deleteArchiveEntry(index);});container.append(item);});}
function closePopup(resolve,value){$('#rmr_summary_popup').hide().off('.ftt');$('#rmr_popup_close,#rmr_popup_cancel,#rmr_popup_save,#rmr_popup_resummarize').off('.ftt');$(document).off('keydown.ftt');resolve?.(value);}
export function openReviewPopup(proposal,endMsgId,archiveDefault){return new Promise(async resolve=>{const {getRollingSummary,acceptRollingSummary,generateRollingSummary}=await import('./memories.js');const popup=$('#rmr_summary_popup'),textarea=$('#rmr_popup_textarea'),accept=$('#rmr_popup_save');$('#rmr_popup_title').text('Review Rolling Summary');$('#rmr_popup_range').text(`Through message ${endMsgId}`);textarea.val(proposal);accept.text('Accept').prop('disabled',false);$('#rmr_popup_resummarize').show();const hasOld=!!getRollingSummary();$('#rmr_popup_archive_wrap').toggle(hasOld);$('#rmr_popup_archive_old').prop('checked',archiveDefault===undefined?settings.archive_on_accept:!!archiveDefault);popup.css('display','flex');const cancel=()=>closePopup(resolve,false);$('#rmr_popup_cancel,#rmr_popup_close').off('.ftt').on('click.ftt',cancel);popup.off('.ftt').on('click.ftt',event=>{if(event.target===popup[0])cancel();});$(document).off('keydown.ftt').on('keydown.ftt',event=>{if(event.key==='Escape')cancel();});accept.off('.ftt').on('click.ftt',async()=>{const text=textarea.val().trim();if(!text){toastr.warning('Summary cannot be empty.','Fill the Time');return;}accept.prop('disabled',true);if(await acceptRollingSummary(text,endMsgId,hasOld&&$('#rmr_popup_archive_old').prop('checked')))closePopup(resolve,true);else accept.prop('disabled',false);});$('#rmr_popup_resummarize').off('.ftt').on('click.ftt',async function(){const button=$(this),old=button.html();button.prop('disabled',true).html('<i class="fa-solid fa-spinner fa-spin"></i>');try{const result=await generateRollingSummary(endMsgId);if(result)textarea.val(result);}finally{button.prop('disabled',false).html(old);}});});}
function openEditPopup(text){return new Promise(async resolve=>{const {updateRollingSummaryText}=await import('./memories.js');const popup=$('#rmr_summary_popup'),textarea=$('#rmr_popup_textarea');$('#rmr_popup_title').text('Edit Active Summary');$('#rmr_popup_range').text('');textarea.val(text);$('#rmr_popup_archive_wrap,#rmr_popup_resummarize').hide();$('#rmr_popup_save').text('Save').prop('disabled',false);popup.css('display','flex');const cancel=()=>closePopup(resolve,false);$('#rmr_popup_cancel,#rmr_popup_close').off('.ftt').on('click.ftt',cancel);popup.off('.ftt').on('click.ftt',event=>{if(event.target===popup[0])cancel();});$(document).off('keydown.ftt').on('keydown.ftt',event=>{if(event.key==='Escape')cancel();});$('#rmr_popup_save').off('.ftt').on('click.ftt',async()=>{const value=textarea.val().trim();if(value&&await updateRollingSummaryText(value))closePopup(resolve,true);});});}
export async function showClearOrRestoreDialog(){const {getRollingSummary,getArchiveEntries,restorePreviousFromArchive,clearRollingSummary}=await import('./memories.js');if(!getRollingSummary()){toastr.info('No active summary.','Fill the Time');return false;}const canRestore=getArchiveEntries().length>0;return new Promise(resolve=>{const overlay=$(`<div class="rmr-choice-overlay"><div class="rmr-choice-dialog"><h3>Change active summary</h3><p>${canRestore?'Restore the newest archive, create empty, or cancel.':'No archive is available. Create empty or cancel.'}</p><div class="rmr-choice-actions">${canRestore?'<button class="menu_button restore">Restore latest</button>':''}<button class="menu_button empty">Create empty</button><button class="menu_button cancel">Cancel</button></div></div></div>`);$('body').append(overlay);let settled=false;const finish=value=>{if(settled)return;settled=true;$(document).off('keydown.fttChoice');overlay.remove();resolve(value);};overlay.find('.cancel').on('click',()=>finish(false));overlay.on('click',event=>{if(event.target===overlay[0])finish(false);});$(document).off('keydown.fttChoice').on('keydown.fttChoice',event=>{if(event.key==='Escape')finish(false);});overlay.find('.restore').on('click',async()=>finish(await restorePreviousFromArchive()));overlay.find('.empty').on('click',async()=>finish(await clearRollingSummary()));});}
