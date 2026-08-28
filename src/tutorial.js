import { loadTutorialTranslations, getTutorialText } from './locales.js';

const VERSION = 5;
const STORAGE_KEY = 'fill-the-time-tutorial-completed';
const steps = [
    { key: 'welcome', title: 'One summary that grows with your story', body: 'Fill the Time maintains one rolling cumulative summary per chat. Each accepted update replaces the active summary; the previous version can be archived.' },
    { key: 'profile', title: 'Choose a summarization profile', body: 'Select a Connection Manager profile. Use a capable model because it must preserve old facts while merging new events.', selector: '#rmr_profile' },
    { key: 'preset', title: 'Create reusable prompt presets', body: 'Edit the System and User prompts, keep {{previousSummary}} and {{content}}, then select Save New. Update overwrites the selected preset; Export and Import share it as JSON.', selector: '#rmr_summarize_preset' },
    { key: 'button', title: 'End a section with ⏹', body: 'Hover a message and click ⏹. The extension summarizes only messages after the active summary while supplying the prior summary to the model.', selector: '#rmr_chapter_button' },
    { key: 'review', title: 'Review before changing data', body: 'Edit, Re-summarize, Accept, or Cancel the proposal. Nothing is hidden or replaced until you press Accept.', selector: '#rmr_active_summary_container' },
    { key: 'regenerate', title: 'Regenerate an accepted summary', body: 'Use Regenerate on the active summary. A prior archive is used as its base when available; otherwise the full chat through that endpoint is summarized again. Cancel keeps the current summary.', selector: '#rmr_active_summary_container' },
    { key: 'macro', title: 'Use {{fillthetime}} in Prompt Manager', body: 'Create a Prompt Manager entry containing {{fillthetime}} and place it in your Chat Completion preset. Disable automatic injection to avoid duplicate context.' },
    { key: 'archive', title: 'Per-chat archive', body: 'When accepting an update, you can archive the previous cumulative summary. The archive belongs only to the current chat.', selector: '#rmr_archive_container' },
    { key: 'behavior', title: 'Control hiding and chunking', body: 'Accepted message ranges can be hidden from the model. Long ranges are split into chunks and can resume after an API error.', selector: '#rmr_hide_chapter' },
    { key: 'inject', title: 'Optional automatic injection', body: 'Inject at Depth supports {{fillthetime}}, {{lastMessageId}}, and {{firstIncludedMessageId}}. Do not use it together with the same Prompt Manager entry unless duplicate context is intentional.', selector: '#rmr_inject_enabled' },
    { key: 'done', title: 'Ready', body: 'Use /fillthetime-end, /fillthetime-show, and /fillthetime-clear as command alternatives. Each chat keeps its own active summary and archive.' },
];
let index = 0, popup = null, highlight = null;
const translated = (step, field) => getTutorialText(`tutorial_${step.key}_${field}`, step[field]);
const label = (key, fallback) => getTutorialText(key, fallback);
function removeHighlight() { highlight?.removeClass('rmr-tutorial-highlight'); highlight = null; }
function show() {
    if (!popup) return;
    const step = steps[index];
    popup.find('.rmr-tutorial-title').text(translated(step, 'title'));
    popup.find('.rmr-tutorial-body').text(translated(step, 'body'));
    popup.find('.rmr-tutorial-step-indicator').text(`${index + 1} / ${steps.length}`);
    popup.find('.rmr-tutorial-prev').text(label('rmr_previous', 'Previous')).prop('disabled', index === 0);
    popup.find('.rmr-tutorial-next').text(index === steps.length - 1 ? label('rmr_finish', 'Finish') : label('rmr_next', 'Next'));
    popup.find('.rmr-tutorial-close').attr('aria-label', label('rmr_close', 'Close'));
    removeHighlight();
    if (step.selector) {
        highlight = $(step.selector).first();
        highlight.addClass('rmr-tutorial-highlight');
        highlight[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
export function refreshTutorialLocale() { show(); }
export async function startTutorial() {
    await loadTutorialTranslations();
    endTutorial(false);
    index = 0;
    popup = $(`<div id="rmr-tutorial-popup" role="dialog" aria-modal="true"><div class="rmr-tutorial-header"><span class="rmr-tutorial-title"></span><span class="rmr-tutorial-step-indicator"></span><button class="rmr-tutorial-close"><i class="fa-solid fa-xmark"></i></button></div><div class="rmr-tutorial-body"></div><div class="rmr-tutorial-footer"><button class="menu_button rmr-tutorial-prev"></button><button class="menu_button rmr-tutorial-next"></button></div></div>`);
    $('body').append(popup);
    popup.css({ top: '80px', right: '30px' });
    popup.find('.rmr-tutorial-close').on('click', () => endTutorial(false));
    popup.find('.rmr-tutorial-prev').on('click', () => { if (index > 0) { index--; show(); } });
    popup.find('.rmr-tutorial-next').on('click', () => { if (index < steps.length - 1) { index++; show(); } else endTutorial(true); });
    show();
}
export function endTutorial(completed = true) { removeHighlight(); popup?.remove(); popup = null; if (completed) localStorage.setItem(STORAGE_KEY, String(VERSION)); }
export function initTutorialUI() { $('#rmr_start_tutorial,#rmr_open_help').off('click.fillthetime').on('click.fillthetime', startTutorial); }
