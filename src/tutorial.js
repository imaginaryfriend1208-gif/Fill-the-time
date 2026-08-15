import { loadTutorialTranslations, getTutorialText } from './locales.js';

const VERSION=4;
const STORAGE_KEY='fill-the-time-tutorial-completed';
const steps=[
 {key:'welcome',title:'One summary that grows with your story',body:'Fill the Time now maintains one rolling cumulative summary per chat. Every accepted update replaces the active summary; optionally, the old version goes into that chat’s archive.'},
 {key:'profile',title:'Choose a summarization profile',body:'Select a Connection Manager profile for summarization. A capable model is recommended because it must preserve old facts while merging new events.',selector:'#rmr_profile'},
 {key:'button',title:'End a section with ⏹',body:'Hover a message and click ⏹. The extension summarizes only messages after the current summary, while supplying the prior summary to the model.',selector:'#rmr_chapter_button'},
 {key:'review',title:'Review before changing data',body:'The proposal opens in an editor. Accept it, edit it, generate another version, or cancel. Nothing is hidden or replaced until you press Accept.',selector:'#rmr_active_summary_container'},
 {key:'macro',title:'Put {{fillthetime}} in Prompt Manager',body:'Create a Prompt Manager entry containing {{fillthetime}} and place it anywhere in your Chat Completion preset, like character or persona prompts. Disable automatic injection to avoid duplicates.'},
 {key:'archive',title:'Per-chat archive',body:'When accepting an update, you can archive the previous summary. The archive belongs only to the current chat. You can inspect or delete entries, and restore the newest one.',selector:'#rmr_archive_container'},
 {key:'behavior',title:'Control hiding and chunking',body:'Accepted message ranges can be hidden from the model. Long ranges are split into chunks and can resume after an API error.',selector:'#rmr_hide_chapter'},
 {key:'inject',title:'Optional automatic injection',body:'If you do not want a Prompt Manager entry, enable Inject at Depth. Do not use both methods unless you intentionally want duplicate context.',selector:'#rmr_inject_enabled'},
 {key:'done',title:'Ready',body:'Use /fillthetime-end, /fillthetime-show, and /fillthetime-clear as command alternatives. Each chat keeps its own active summary and archive.'},
];
let index=0,popup=null,highlight=null;
const translated=(step,field)=>getTutorialText(`tutorial_${step.key}_${field}`,step[field]);
function removeHighlight(){highlight?.removeClass('rmr-tutorial-highlight');highlight=null;}
function show(){if(!popup)return;const step=steps[index];popup.find('.rmr-tutorial-title').html(translated(step,'title'));popup.find('.rmr-tutorial-body').html(translated(step,'body'));popup.find('.rmr-tutorial-step-indicator').text(`${index+1} / ${steps.length}`);popup.find('.rmr-tutorial-prev').prop('disabled',index===0);popup.find('.rmr-tutorial-next').text(index===steps.length-1?'Finish':'Next');removeHighlight();if(step.selector){highlight=$(step.selector).first();highlight.addClass('rmr-tutorial-highlight');highlight[0]?.scrollIntoView({behavior:'smooth',block:'center'});}}
export async function startTutorial(){await loadTutorialTranslations();endTutorial(false);index=0;popup=$(`<div id="rmr-tutorial-popup"><div class="rmr-tutorial-header"><span class="rmr-tutorial-title"></span><span class="rmr-tutorial-step-indicator"></span><button class="rmr-tutorial-close"><i class="fa-solid fa-xmark"></i></button></div><div class="rmr-tutorial-body"></div><div class="rmr-tutorial-footer"><button class="menu_button rmr-tutorial-prev">Previous</button><button class="menu_button rmr-tutorial-next">Next</button></div></div>`);$('body').append(popup);popup.css({top:'80px',right:'30px'});popup.find('.rmr-tutorial-close').on('click',()=>endTutorial(false));popup.find('.rmr-tutorial-prev').on('click',()=>{if(index>0){index--;show();}});popup.find('.rmr-tutorial-next').on('click',()=>{if(index<steps.length-1){index++;show();}else endTutorial(true);});show();}
export function endTutorial(completed=true){removeHighlight();popup?.remove();popup=null;if(completed)localStorage.setItem(STORAGE_KEY,String(VERSION));}
export function initTutorialUI(){$('#rmr_start_tutorial').off('click.fillthetime').on('click.fillthetime',startTutorial);}
