#!/usr/bin/env node
/**
 * Runtime test for prompt assembly.
 *
 * verify.mjs is static: it greps for invariants. This file is different -- it lifts the real
 * generateFromText() verbatim out of src/memories.js, stubs only the network call and the
 * SillyTavern globals, and then *executes* it. So it answers the question "which prompt and
 * which profile does each pass actually end up sending, and what happens to the macros"
 * rather than "does the source look right".
 *
 *   node tools/test-prompts.mjs
 *
 * Exit code 0 = all assertions hold.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/memories.js'), 'utf8');
const WORLD_INFO = '<<WORLDINFO>>';

function matchPair(text, index, open, close) {
    let depth = 0;
    for (let i = index; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close && --depth === 0) return i;
    }
    throw new Error('unbalanced delimiters while slicing source');
}

/** Slice a function out of the real module by balancing its parens then its braces. */
function extractFunction(name) {
    const candidates = ['export async function ', 'async function ', 'export function ', 'function ']
        .map(prefix => source.indexOf(`${prefix}${name}(`))
        .filter(index => index >= 0);
    if (!candidates.length) throw new Error(`${name}() not found in src/memories.js`);
    const start = Math.min(...candidates);
    const closeParen = matchPair(source, source.indexOf('(', start), '(', ')');
    const openBrace = source.indexOf('{', closeParen);
    return source.slice(start, matchPair(source, openBrace, '{', '}') + 1);
}

let generateBody = extractFunction('generateFromText');
const injectBody = extractFunction('updateSummaryInjection');
const callSite = 'let response = await sendRequest(profileId, messages, maxTokens, override);';
if (!generateBody.includes(callSite)) throw new Error('sendRequest call site changed; update this test');
generateBody = generateBody.replace(callSite, 'let response = { content: JSON.stringify({ messages, profileId }), finishReason: \'stop\' };');
// Structural markers only. Anything tied to how macros are substituted would make this
// guard fail whenever that implementation legitimately changes.
for (const marker of ['isChunkPass', 'userPrompt', 'systemPrompt', 'messages.push({ role:']) {
    if (!generateBody.includes(marker)) throw new Error(`extraction lost "${marker}"; the slice is wrong`);
}

// Built by concatenation, never a template literal: the extracted code contains its own
// backticks and ${...} and would otherwise be evaluated while building this string.
const moduleSource = [
    'let internalGenerationDepth = 0;',
    'let commandArgs = {};',
    'let rollingSummary = null;',
    'let settings = {};',
    'let __chat = [];',
    'export function __configure(nextSettings, activeSummary, chat) {',
    '    settings = nextSettings;',
    '    rollingSummary = activeSummary === null || activeSummary === undefined',
    '        ? null',
    "        : (typeof activeSummary === 'string' ? { summary: activeSummary } : activeSummary);",
    '    __chat = chat || [];',
    '}',
    'export function __depth() { return internalGenerationDepth; }',
    'const rawInfo = () => {};',
    "const getActiveSummaryText = () => rollingSummary?.summary || '';",
    "const resolveChunkProfileId = () => 'CHUNK_PROFILE';",
    "const resolveMergeProfileId = () => 'MERGE_PROFILE';",
    'const rateLimitSlot = async () => {};',
    'const setProgress = async () => {};',
    'const rawWarn = () => {};',
    'let lastGenerationTruncated = false;',
    "const CONTINUATION_PROMPT = 'continue';",
    "const getProfileName = () => 'P';",
    'const getMaxTokensForProfile = async () => 1024;',
    'const buildOverridePayload = () => ({});',
    'const getReasoningEffort = () => undefined;',
    'const getIncludeReasoning = () => undefined;',
    'const getWorldInfoText = async () => ' + JSON.stringify(WORLD_INFO) + ';',
    // Kept so the test runs against both the old two-step helper and the single-pass version.
    'const substituteWorldInfo = async text => text.replace(/{{worldinfo}}/gi, ' + JSON.stringify(WORLD_INFO) + ');',
    // substituteParams is SillyTavern's own macro engine (card macros). Identity here: this
    // test covers only the substitution IF Memory performs itself.
    "const getContext = () => ({ substituteParams: text => text, name1: 'You', name2: 'Bot', chat: __chat });",
    "const INJECT_KEY = 'INJECT';",
    'const extension_prompt_types = { IN_CHAT: 1 };',
    'const extension_prompt_roles = { SYSTEM: 0 };',
    'let __injection = null;',
    'const setExtensionPrompt = (key, value) => { __injection = value; };',
    'export function __lastInjection() { return __injection; }',
    generateBody,
    injectBody,
    'export { generateFromText };',
].join('\n');

const tempFile = join(tmpdir(), `ifmemory-prompts-${process.pid}.mjs`);
writeFileSync(tempFile, moduleSource, 'utf8');
let mod;
try { mod = await import(pathToFileURL(tempFile).href); }
finally { try { unlinkSync(tempFile); } catch { /* best effort */ } }

const MERGE_SYS = 'MSYS[{{previousSummary}}]';
const MERGE_USR = 'MUSR prev=[{{previousSummary}}] content=[{{content}}]';
const CHUNK_SYS = 'CSYS';
const CHUNK_USR = 'CUSR content=[{{content}}]';

const baseSettings = () => ({
    use_custom_chunk_prompts: false,
    memory_system_prompt: MERGE_SYS,
    memory_prompt_template: MERGE_USR,
    chunk_system_prompt: CHUNK_SYS,
    chunk_prompt_template: CHUNK_USR,
});

async function send({ settings = {}, active = null, content = 'BODY', includePrevious, previousOverride = null }) {
    mod.__configure({ ...baseSettings(), ...settings }, active);
    const raw = await mod.generateFromText(content, 0, includePrevious, previousOverride, {});
    const payload = JSON.parse(raw);
    return {
        system: payload.messages.find(m => m.role === 'system')?.content ?? null,
        user: payload.messages.find(m => m.role === 'user').content,
        profileId: payload.profileId,
        messageCount: payload.messages.length,
    };
}

let failures = 0;
function assert(name, condition, detail) {
    if (!condition) failures++;
    console.log(`${condition ? 'pass' : 'FAIL'}  ${name}`);
    if (!condition && detail !== undefined) console.log(`        got: ${detail}`);
}
const eq = (name, actual, expected) => assert(name, actual === expected, `${JSON.stringify(actual)}\n        want: ${JSON.stringify(expected)}`);

console.log('\n-- which prompt / which profile --');
let r = await send({ includePrevious: false, settings: { use_custom_chunk_prompts: true } });
eq('chunk pass -> chunk user prompt', r.user, 'CUSR content=[BODY]');
eq('chunk pass -> chunk system prompt', r.system, 'CSYS');
eq('chunk pass -> chunk profile', r.profileId, 'CHUNK_PROFILE');

r = await send({ includePrevious: false, settings: { use_custom_chunk_prompts: false }, active: 'OLD' });
eq('chunk pass ignores the removed toggle and still uses the chunk prompt', r.user, 'CUSR content=[BODY]');

r = await send({ includePrevious: true, active: 'OLD', settings: { use_custom_chunk_prompts: true } });
eq('merge pass -> merge prompt even while the chunk toggle is on', r.user, 'MUSR prev=[OLD] content=[BODY]');
eq('merge pass -> merge system prompt', r.system, 'MSYS[OLD]');
eq('merge pass -> merge profile', r.profileId, 'MERGE_PROFILE');

console.log('\n-- previousSummary plumbing --');
r = await send({ includePrevious: true, active: 'OLD' });
eq('normal merge carries the active summary', r.user, 'MUSR prev=[OLD] content=[BODY]');
r = await send({ includePrevious: true, active: 'OLD', previousOverride: '' });
eq('fresh merge (override "") really sends nothing', r.user, 'MUSR prev=[] content=[BODY]');
r = await send({ includePrevious: true, active: 'OLD', previousOverride: undefined });
eq('override undefined falls back to the active summary', r.user, 'MUSR prev=[OLD] content=[BODY]');
r = await send({ includePrevious: true, active: null });
eq('no active summary -> empty previousSummary, not "null"', r.user, 'MUSR prev=[] content=[BODY]');
r = await send({ includePrevious: true, active: 'OLD', settings: { memory_prompt_template: 'camel=[{{previousSummary}}] snake=[{{previous_summary}}]' } });
eq('{{previous_summary}} aliases {{previousSummary}}', r.user, 'camel=[OLD] snake=[OLD]');

console.log('\n-- world info --');
r = await send({ includePrevious: false, settings: { use_custom_chunk_prompts: true, chunk_prompt_template: 'U=[{{worldinfo}}]', chunk_system_prompt: 'S=[{{WorldInfo}}]' } });
eq('{{worldinfo}} expands in the user prompt', r.user, `U=[${WORLD_INFO}]`);
eq('{{WorldInfo}} is case insensitive in the system prompt', r.system, `S=[${WORLD_INFO}]`);

console.log('\n-- empty system prompt --');
r = await send({ includePrevious: false, settings: { use_custom_chunk_prompts: true, chunk_system_prompt: '   ' } });
assert('whitespace-only system prompt is dropped', r.messageCount === 1 && r.system === null, `count=${r.messageCount}`);

console.log('\n-- hostile content (the part that was silently corrupting prompts) --');
const dollars = "price 5$ and $& and $` and $' and $1 end";
r = await send({ includePrevious: false, content: dollars, settings: { use_custom_chunk_prompts: true } });
eq('$& $` $\' $1 in chat text survive verbatim', r.user, `CUSR content=[${dollars}]`);

r = await send({ includePrevious: true, active: 'summary with $& inside', content: 'BODY' });
eq('$& in the previous summary survives verbatim', r.user, 'MUSR prev=[summary with $& inside] content=[BODY]');

r = await send({ includePrevious: true, active: 'OLD', content: 'explain {{previousSummary}} please' });
eq('literal {{previousSummary}} in chat text is not expanded', r.user, 'MUSR prev=[OLD] content=[explain {{previousSummary}} please]');

r = await send({ includePrevious: false, content: 'see {{worldinfo}} here', settings: { use_custom_chunk_prompts: true } });
eq('literal {{worldinfo}} in chat text is not expanded', r.user, 'CUSR content=[see {{worldinfo}} here]');

r = await send({ includePrevious: false, content: 'nested {{content}} marker', settings: { use_custom_chunk_prompts: true } });
eq('literal {{content}} in chat text is not expanded', r.user, 'CUSR content=[nested {{content}} marker]');

console.log('\n-- depth injection (same substitution rule) --');
function inject({ prompt, active, chatLength = 0, enabled = true }) {
    mod.__configure({ inject_enabled: enabled, inject_prompt: prompt, inject_depth: 0, inject_role: 0 }, active, new Array(chatLength).fill({}));
    mod.updateSummaryInjection();
    return mod.__lastInjection();
}
eq('injection disabled clears the prompt', inject({ prompt: 'x', active: null, enabled: false }), '');
eq('{{fillthetime}} carries a summary containing $&',
    inject({ prompt: 'S=[{{fillthetime}}]', active: { summary: 'has $& inside', endMsgId: 4 }, chatLength: 10 }), 'S=[has $& inside]');
eq('{{lastMessageId}} and {{firstIncludedMessageId}} resolve',
    inject({ prompt: 'last={{lastMessageId}} first={{firstIncludedMessageId}}', active: { summary: 's', endMsgId: 4 }, chatLength: 10 }), 'last=9 first=5');
eq('a macro sitting inside the summary is not re-expanded',
    inject({ prompt: '[{{fillthetime}}]', active: { summary: 'literal {{lastMessageId}} kept', endMsgId: 4 }, chatLength: 10 }), '[literal {{lastMessageId}} kept]');
eq('no active summary -> empty macro and first id 0',
    inject({ prompt: '[{{fillthetime}}] first={{firstIncludedMessageId}}', active: null, chatLength: 3 }), '[] first=0');

console.log('\n-- bookkeeping --');
assert('internal-generation depth unwinds to zero', mod.__depth() === 0, String(mod.__depth()));

console.log(failures ? `\n${failures} assertion(s) failed\n` : '\nAll prompt assertions passed\n');
process.exit(failures ? 1 : 0);
