import { eventSource, event_types } from '../../../../script.js';
import { loadSlashCommands } from './src/commands.js';
import { addMessageButtons, resetMessageButtons } from './src/messages.js';
import { loadSettings, changeCharaName, renderActiveSummary, renderArchiveList } from './src/settings.js';
import { initFillTheTimeMacros, loadRollingSummaryData, updateSummaryInjection } from './src/memories.js';
import { loadUITranslations } from './src/locales.js';

export const extension_name = 'fill-the-time';
const extensionBasePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
export const extension_path = extensionBasePath.replace(/^\//, '');
export const getExtensionAssetPath = (relativePath='') => relativePath ? `${extensionBasePath}/${relativePath.replace(/^\/+/, '')}` : extensionBasePath;
export let STVersion;

function compatible(version){const parts=String(version?.pkgVersion||'0.0').split('.').map(Number);return parts[0]>0||parts[1]>=13;}
function onRendered(id){addMessageButtons($(`.mes[mesid="${id}"]`));}

jQuery(()=>{
    eventSource.on(event_types.APP_READY,async()=>{
        STVersion=await (await fetch('/version')).json();
        if(!compatible(STVersion)){toastr.error('Please update SillyTavern to 1.13 or newer.','Fill the Time');throw new Error('Fill the Time requires SillyTavern 1.13+');}
        await loadUITranslations();
        await loadSettings();
        initFillTheTimeMacros();
        loadSlashCommands();
        await loadRollingSummaryData();
        updateSummaryInjection();
        resetMessageButtons();
        await renderActiveSummary();
        await renderArchiveList();
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED,onRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED,onRendered);
    eventSource.on(event_types.MORE_MESSAGES_LOADED,resetMessageButtons);
    eventSource.on(event_types.CHARACTER_RENAMED,changeCharaName);
    eventSource.on(event_types.CHAT_CHANGED,async chatId=>{
        if(!chatId)return;
        await loadRollingSummaryData();
        resetMessageButtons();
        await renderActiveSummary();
        await renderArchiveList();
    });
});
