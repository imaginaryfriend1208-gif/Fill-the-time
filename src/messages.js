import { getContext } from '../../../../extensions.js';
import { settings, Buttons } from './settings.js';
import { endChapter, getRollingSummary } from './memories.js';

const TITLE_END = 'Create or update the rolling summary here';
const TITLE_ACTIVE = 'Restore an older summary or create an empty one';
const buttonHtml = `<div class="mes_button rmr-button fa-solid fa-circle-stop interactable" title="${TITLE_END}" tabindex="0" role="button" aria-label="${TITLE_END}"></div>`;

export function toggleChapterHighlight(button, messageId) {
    button.off('click.fillthetime');
    const marked = Boolean(getContext().chat[messageId]?.extra?.rmr_chapter);
    button.toggleClass('fa-circle-stop', !marked).toggleClass('rmr-chapter-point fa-circle-check', marked);
    button.prop('title', marked ? TITLE_ACTIVE : TITLE_END).attr('aria-label', marked ? TITLE_ACTIVE : TITLE_END);
    button.on('click.fillthetime', async function (event) {
        const clicked = $(event.currentTarget);
        if (clicked.hasClass('disabled')) return;
        clicked.addClass('disabled fa-spin');
        try {
            const id = Number(clicked.closest('.mes').attr('mesid'));
            const active = getRollingSummary();
            if (getContext().chat[id]?.extra?.rmr_chapter && active?.endMsgId === id) {
                const { showClearOrRestoreDialog } = await import('./settings.js');
                await showClearOrRestoreDialog();
            } else if (getContext().chat[id]?.extra?.rmr_chapter) {
                getContext().chat[id].extra.rmr_chapter = false;
                await getContext().saveChat();
                toggleChapterHighlight(clicked, id);
            } else {
                await endChapter(id);
            }
        } finally { clicked.removeClass('disabled fa-spin'); }
    });
}

export function addMessageButtons(message) {
    const id = Number(message.attr('mesid'));
    const box = message.find('.extraMesButtons');
    const existing = box.find('.rmr-button');
    if (!settings?.show_buttons?.includes(Buttons.STOP)) { existing.remove(); return; }
    if (existing.length) { toggleChapterHighlight(existing, id); return; }
    const button = $(buttonHtml); toggleChapterHighlight(button, id);
    const narrate = box.find('.mes_narrate'); narrate.length ? narrate.after(button) : box.prepend(button);
}

export function resetMessageButtons() {
    document.querySelectorAll('#chat > .mes[mesid]').forEach(element => addMessageButtons($(element)));
}
