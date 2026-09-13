// Runtime probe for G5/G6: extract the REAL sendRequest/extractContent/extractFinishReason/generateFromText
// out of src/memories.js, stub only ConnectionManagerRequestService, and drive them.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/memories.js'), 'utf8');
function matchPair(t, i, o, c) { let d = 0; for (let k = i; k < t.length; k++) { if (t[k] === o) d++; else if (t[k] === c && --d === 0) return k; } throw new Error('unbalanced'); }
function fn(name) {
  const cands = ['export async function ', 'async function ', 'export function ', 'function '].map(p => src.indexOf(`${p}${name}(`)).filter(i => i >= 0);
  if (!cands.length) throw new Error(`${name} not found`);
  const s = Math.min(...cands); const cp = matchPair(src, src.indexOf('(', s), '(', ')'); const ob = src.indexOf('{', cp);
  return src.slice(s, matchPair(src, ob, '{', '}') + 1);
}
const CONT = src.match(/const CONTINUATION_PROMPT = '[^']+';/)[0];

const mod = [
  'let internalGenerationDepth = 0; let commandArgs = {}; let rollingSummary = null; let settings = {}; let lastGenerationTruncated = false;',
  CONT,
  'export const calls = [];',
  'export let queue = [];',
  'export function __set(s, active, q) { settings = s; rollingSummary = active ? { summary: active } : null; queue = q; calls.length = 0; }',
  'export function __truncated() { return lastGenerationTruncated; }',
  'const rawWarn = t => calls.push({ warn: t });',
  "const getActiveSummaryText = () => rollingSummary?.summary || '';",
  'const rawInfo = () => {}; const setProgress = async () => {};',
  "const resolveChunkProfileId = () => 'CHUNK'; const resolveMergeProfileId = () => 'MERGE'; const getProfileName = id => id;",
  'const rateLimitSlot = async () => {}; const getMaxTokensForProfile = async () => 2048; const buildOverridePayload = () => ({});',
  'const getReasoningEffort = () => undefined; const getIncludeReasoning = () => undefined; const getWorldInfoText = async () => "";',
  "const getContext = () => ({ substituteParams: t => t, name1: 'a', name2: 'b' });",
  'export let ConnectionManagerRequestService = { async sendRequest(profileId, messages, maxTokens, custom, override) { calls.push({ profileId, maxTokens, custom, n: messages.length, last: messages.at(-1) }); const next = queue.shift(); if (next instanceof Error) throw next; return next; } };',
  'export function __noCMRS() { ConnectionManagerRequestService = null; }',
  fn('sendRequest'), fn('extractContent'), fn('extractFinishReason'), fn('generateFromText'),
  'export { sendRequest, extractContent, extractFinishReason, generateFromText };',
].join('\n');
const tmp = join(tmpdir(), `ifm-g56-${process.pid}.mjs`); writeFileSync(tmp, mod);
let m; try { m = await import(pathToFileURL(tmp).href); } finally { unlinkSync(tmp); }

let fail = 0; const t = (n, c, got) => { if (!c) fail++; console.log(`${c ? 'pass' : 'FAIL'}  ${n}${c ? '' : `\n        got: ${JSON.stringify(got)}`}`); };
const oai = (content, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }] });
const base = { memory_system_prompt: 'S', memory_prompt_template: 'M[{{previousSummary}}]{{content}}', chunk_system_prompt: 'CS', chunk_prompt_template: 'C{{content}}', merge_max_tokens: 0, chunk_max_tokens: 0, merge_continuations: 2 };

console.log('-- extractFinishReason --');
t('openai length', m.extractFinishReason(oai('x', 'length')) === 'length');
t('openai stop', m.extractFinishReason(oai('x', 'stop')) === 'stop');
t('claude max_tokens', m.extractFinishReason({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }) === 'length');
t('claude end_turn', m.extractFinishReason({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }) === 'stop');
t('gemini MAX_TOKENS', m.extractFinishReason({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }) === 'length');
t('unknown shape -> null', m.extractFinishReason({ foo: 1 }) === null);
t('string -> null', m.extractFinishReason('plain') === null);

console.log('-- extractContent --');
t('openai', m.extractContent(oai('hello')) === 'hello');
t('claude', m.extractContent({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'zz' }, { type: 'text', text: 'b' }] }) === 'a\n\nb');
t('gemini', m.extractContent({ candidates: [{ content: { parts: [{ text: 'g1' }, { text: 'g2' }] } }] }) === 'g1g2');
t('string passthrough', m.extractContent('raw') === 'raw');
t('null -> empty', m.extractContent(null) === '');

console.log('-- sendRequest: no fallback --');
m.__set(base, null, []);
let threw = null; try { await m.sendRequest(null, [{ role: 'user', content: 'x' }], 10, {}); } catch (e) { threw = e; }
t('no profile -> throws (no silent fallback to chat API)', threw && /No Connection Manager profile/.test(threw.message), threw?.message);
m.__set(base, null, [new Error('boom', { cause: new Error('401 unauthorized') })]);
threw = null; try { await m.sendRequest('MERGE', [{ role: 'user', content: 'x' }], 10, {}); } catch (e) { threw = e; }
t('profile error -> throws with profile name + cause', threw && /MERGE/.test(threw.message) && /401/.test(threw.message), threw?.message);
m.__set(base, null, [oai('ok')]);
let r = await m.sendRequest('MERGE', [{ role: 'user', content: 'x' }], 10, {});
t('passes extractData:false so finish_reason survives', m.calls[0].custom.extractData === false, m.calls[0].custom);
t('returns {content, finishReason}', r.content === 'ok' && r.finishReason === 'stop', r);

console.log('-- generateFromText: max tokens per pass --');
m.__set({ ...base, merge_max_tokens: 9000, chunk_max_tokens: 700 }, 'OLD', [oai('m')]);
await m.generateFromText('body', 0, true, null, {});
t('merge uses merge_max_tokens', m.calls[0].maxTokens === 9000 && m.calls[0].profileId === 'MERGE', m.calls[0]);
m.__set({ ...base, merge_max_tokens: 9000, chunk_max_tokens: 700 }, 'OLD', [oai('c')]);
await m.generateFromText('body', 0, false, null, {});
t('chunk uses chunk_max_tokens + chunk prompt (toggle gone)', m.calls[0].maxTokens === 700 && m.calls[0].profileId === 'CHUNK' && m.calls[0].last.content === 'Cbody', m.calls[0]);
m.__set(base, 'OLD', [oai('m')]);
await m.generateFromText('body', 0, true, null, {});
t('0 -> falls back to preset max (2048)', m.calls[0].maxTokens === 2048, m.calls[0]);

console.log('-- continuation --');
m.__set({ ...base, merge_continuations: 2 }, 'OLD', [oai('part one', 'length'), oai('part two', 'length'), oai('part three', 'stop')]);
r = await m.generateFromText('body', 0, true, null, {});
t('3 requests, stitched with space', r === 'part one part two part three' && m.calls.length === 3, { r, n: m.calls.length });
t('continuation carries assistant text + continuation instruction', m.calls[1].n === 4 && m.calls[1].last.role === 'user' && /Continue exactly/.test(m.calls[1].last.content) && m.calls[1].last && m.calls[1].n === 4, m.calls[1]);
t('not flagged truncated after finishing', m.__truncated() === false);
m.__set({ ...base, merge_continuations: 1 }, 'OLD', [oai('a', 'length'), oai('b', 'length')]);
r = await m.generateFromText('body', 0, true, null, {});
t('cap reached & still length -> flagged truncated + warn', m.__truncated() === true && m.calls.some(c => c.warn && /cut off/.test(c.warn)), m.calls.filter(c => c.warn));
m.__set({ ...base, merge_continuations: 0 }, 'OLD', [oai('a', 'length')]);
r = await m.generateFromText('body', 0, true, null, {});
t('merge_continuations=0 -> single request, flagged', r === 'a' && m.__truncated() === true);
m.__set({ ...base, merge_continuations: 5 }, 'OLD', [oai('chunk!', 'length')]);
r = await m.generateFromText('body', 0, false, null, {});
t('chunk pass never continues even if cut', m.calls.filter(c => c.profileId).length === 1 && m.__truncated() === true);
m.__set({ ...base, merge_continuations: 3 }, 'OLD', [oai('x', 'length'), oai('', 'stop')]);
r = await m.generateFromText('body', 0, true, null, {});
t('empty continuation stops the loop', r === 'x' && m.calls.filter(c => c.profileId).length === 2);
// Each response is trimmed on the way in, so a trailing newline cannot survive; the joiner
// therefore always inserts exactly one space between two trimmed pieces.
m.__set({ ...base }, 'OLD', [oai('ends with newline\n', 'length'), oai('next', 'stop')]);
r = await m.generateFromText('body', 0, true, null, {});
t('pieces are trimmed then joined by a single space', r === 'ends with newline next', r);
m.__set({ ...base }, 'OLD', [oai('mid-sen', 'length'), oai('tence.', 'stop')]);
r = await m.generateFromText('body', 0, true, null, {});
t('word cut mid-way still gets a separator (readable, never glued)', r === 'mid-sen tence.', r);

console.log(fail ? `\n${fail} FAIL` : '\nALL PASS'); process.exit(fail ? 1 : 0);
