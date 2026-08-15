import { extension_settings, getContext } from '../../../../extensions.js';
import { commonEnumProviders } from '../../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { enumTypes, SlashCommandEnumValue } from '../../../../slash-commands/SlashCommandEnumValue.js';
import { saveChatConditional, reloadCurrentChat, systemUserName } from '../../../../../script.js';
import { stringToRange } from '../../../../utils.js';
import { endChapter, getRollingSummary } from './memories.js';
import { debug } from './logging.js';

const profilesProvider = () => [new SlashCommandEnumValue('<None>'), ...(extension_settings.connectionManager?.profiles || []).map(profile => new SlashCommandEnumValue(profile.name, null, enumTypes.name))];
const profileIdFromName = name => (extension_settings.connectionManager?.profiles || []).find(profile => profile.name === name)?.id || '';

async function removeReasoningBlocks(input) {
    const context=getContext(),chat=context.chat;
    if(!input){toastr.warning('Usage: /remove-reasoning 1-10','Fill the Time');return '';}
    if(!Array.isArray(chat)||!chat.length)return '';
    try{
        const range=stringToRange(input.trim(),0,chat.length-1);if(!range){toastr.error('Invalid range.','Fill the Time');return '';}
        let removed=0;
        for(let index=range.start;index<=range.end;index++){
            const message=chat[index];if(!message||message.is_user||message.extra?.reasoning===undefined)continue;
            delete message.extra.reasoning;delete message.extra.reasoning_duration;delete message.extra.reasoning_type;
            $(`.mes[mesid="${index}"]`).find('.mes_reasoning_details,.mes_reasoning').remove();removed++;
        }
        if(removed){await saveChatConditional();await reloadCurrentChat();toastr.success(`Removed ${removed} reasoning block${removed===1?'':'s'}.`,'Fill the Time');}
        else toastr.info('No reasoning blocks found.','Fill the Time');
        return `Removed ${removed} reasoning block${removed===1?'':'s'}`;
    }catch(error){debug('Remove reasoning failed:',error);toastr.error('Failed to remove reasoning.','Fill the Time');return '';}
}

async function removeToolCalls(){
    const chat=getContext().chat;if(!Array.isArray(chat)||!chat.length)return 'No messages in chat.';
    const remove=new Set();
    for(let index=0;index<chat.length;index++){
        const message=chat[index];if(!message)continue;
        const tool=message.extra?.tool_invocations!==undefined||(message.is_system&&message.name===systemUserName&&message.mes?.includes('Tool calls:'))||(message.extra?.isSmallSys===true&&message.mes?.includes('Tool calls:'));
        if(!tool)continue;remove.add(index);
        const previous=chat[index-1];if(previous&&!previous.is_user&&!previous.is_system&&previous.extra?.type!=='narrator'&&previous.name!==systemUserName)remove.add(index-1);
    }
    if(!remove.size){toastr.info('No tool-call messages found.','Fill the Time');return 'No tool-call messages found.';}
    [...remove].sort((a,b)=>b-a).forEach(index=>chat.splice(index,1));await saveChatConditional();await reloadCurrentChat();
    const result=`Removed ${remove.size} tool-call related message${remove.size===1?'':'s'}.`;toastr.success(result,'Fill the Time');return result;
}

export function loadSlashCommands(){
    const context=getContext(),parser=context.SlashCommandParser,Command=context.SlashCommand,Arg=context.SlashCommandArgument,Named=context.SlashCommandNamedArgument,types=context.ARGUMENT_TYPE;
    const endCallback=async(args,value)=>{
        const chat=context.chat||[];const id=value===''||value==null?chat.length-1:Number(value);
        if(!Number.isInteger(id)||id<0||id>=chat.length){toastr.error(`Message ID must be 0-${Math.max(0,chat.length-1)}.`,'Fill the Time');return '';}
        if(args.profile){args.profile=profileIdFromName(args.profile);if(!args.profile){toastr.error('Profile not found.','Fill the Time');return '';}}
        await endChapter(id,args);return '';
    };
    parser.addCommandObject(Command.fromProps({name:'fillthetime-end',aliases:['chapter-end'],callback:endCallback,unnamedArgumentList:[Arg.fromProps({description:'Message ID; defaults to latest',typeList:[types.NUMBER],isRequired:false,enumProvider:commonEnumProviders.messages()})],namedArgumentList:[Named.fromProps({name:'profile',description:'Connection profile name',enumProvider:profilesProvider,isRequired:false}),Named.fromProps({name:'quiet',description:'Suppress toasts',typeList:[types.BOOLEAN],isRequired:false})],helpString:'Generate and review the rolling summary through a message.'}));
    parser.addCommandObject(Command.fromProps({name:'fillthetime-show',callback:()=>getRollingSummary()?.summary||'',helpString:'Return the active {{fillthetime}} summary.'}));
    parser.addCommandObject(Command.fromProps({name:'fillthetime-clear',callback:async()=>{const {showClearOrRestoreDialog}=await import('./settings.js');await showClearOrRestoreDialog();return '';},helpString:'Restore the latest archived summary or create an empty summary.'}));
    parser.addCommandObject(Command.fromProps({name:'remove-reasoning',aliases:['removereasoning','remreason'],callback:async(args,value)=>removeReasoningBlocks(value),unnamedArgumentList:[Arg.fromProps({description:'Message ID or range',typeList:[types.STRING],isRequired:true})],helpString:'Remove reasoning blocks from a message range.',returns:'Status message'}));
    parser.addCommandObject(Command.fromProps({name:'remove-tool-calls',aliases:['rtc','removetoolcalls'],callback:removeToolCalls,helpString:'Remove tool-call results and invoking assistant messages.',returns:'Status message'}));
}
