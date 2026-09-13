#!/usr/bin/env node
/**
 * IF Memory verification harness.
 *
 * Zero dependency, offline. Run:  node tools/verify.mjs [--group <name>]
 *
 * Groups:
 *   syntax            - every .js parses (node --check), every .json parses
 *   exports           - no public export of src/memories.js disappeared
 *   profile-routing   - merge pass and chunk pass resolve different profiles
 *   archive-isolation - archive can be ignored / hidden / wiped per chat
 *   stock-hygiene     - stale stocked chunks + checkpoints cannot leak into a merge
 *   ui-ids            - every #rmr_* selector used by JS exists in markup
 *   css-alignment     - End Message ID / Stages row is laid out like the connection row
 *   i18n              - locale files parse and contain the new keys
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const args = process.argv.slice(2);
const onlyGroup = args.includes('--group') ? args[args.indexOf('--group') + 1] : null;

const results = [];
const check = (group, name, condition, hint = '') => results.push({ group, name, ok: Boolean(condition), hint });

function walk(dir, out = []) {
    for (const entry of readdirSync(join(root, dir))) {
        const rel = join(dir, entry);
        if (entry === '.git' || entry === 'node_modules') continue;
        if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
        else out.push(rel.split('\\').join('/'));
    }
    return out;
}
const files = walk('.');
const jsFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
const jsonFiles = files.filter(f => f.endsWith('.json'));

// ---------------------------------------------------------------- syntax
for (const file of jsFiles) {
    let ok = true;
    let message = '';
    try { execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }); }
    catch (error) { ok = false; message = String(error.stderr || error.message).split('\n').slice(0, 3).join(' '); }
    check('syntax', `parses: ${file}`, ok, message);
}
for (const file of jsonFiles) {
    let ok = true;
    let message = '';
    try { JSON.parse(read(file)); } catch (error) { ok = false; message = error.message; }
    check('syntax', `valid JSON: ${file}`, ok, message);
}

const memories = read('src/memories.js');
const settingsJs = read('src/settings.js');
const commandsJs = read('src/commands.js');
const indexJs = read('index.js');
const html = read('templates/settings_panel.html');
const css = read('style.css');

// ------------------------------------------------------------- stock state
for (const file of ['src/chunk-select.js', 'src/summary-state.js', 'tools/test-stock-state.mjs']) {
    check('stock-state', `${file} exists`, existsSync(join(root, file)));
}
for (const file of ['src/chunk-select.js', 'src/summary-state.js']) {
    const source = existsSync(join(root, file)) ? read(file) : '';
    check('stock-state', `${file} is independent of SillyTavern`,
        !source.includes('extensions.js') && !source.includes('script.js'));
}
check('stock-state', 'chunk selector does not reference archive state',
    existsSync(join(root, 'src/chunk-select.js')) && !read('src/chunk-select.js').toLowerCase().includes('archive'));
check('stock-state', 'stock-state executable test has at least 20 assertions',
    existsSync(join(root, 'tools/test-stock-state.mjs')) && (read('tools/test-stock-state.mjs').match(/check\(/g) || []).length >= 20);

// ---------------------------------------------------------------- notify
check('notify', 'central notifier exists', existsSync(join(root, 'src/notify.js')));
const notifyJs = existsSync(join(root, 'src/notify.js')) ? read('src/notify.js') : '';
check('notify', 'memories never calls toastr directly', !/toastr\./.test(memories));
check('notify', 'progress lanes replace prior live toast', /active\.get\(lane\)/.test(notifyJs) && /clear\(lane\)/.test(notifyJs));
check('notify', 'per-chunk generating toast is removed', !/Generating chunk summary/.test(memories));

// ---------------------------------------------------------------- exports
const PUBLIC_EXPORTS = [
    'getRollingSummary', 'getArchiveEntries', 'getStockedChunks', 'loadRollingSummaryData',
    'deleteArchiveEntry', 'updateRollingSummaryText', 'restorePreviousFromArchive', 'clearRollingSummary',
    'initFillTheTimeMacros', 'updateSummaryInjection', 'isValidConnectionProfileId', 'resolveConnectionProfileId',
    'getReasoningEffort', 'getIncludeReasoning', 'getMaxTokensForProfile', 'buildOverridePayload',
    'isStocking', 'invalidateStockFrom', 'clearStockedChunks', 'deleteStockedChunk', 'purgeStockedChunk', 'regenerateStockedChunk',
    'restockChunks', 'autoStockChunks', 'getWorldInfoText', 'getChunkTokenLimit', 'getStockContextLimit',
    'generateRollingSummary', 'generateActiveSummaryReplacement', 'acceptActiveSummaryReplacement',
    'regenerateActiveSummary', 'acceptRollingSummary', 'autoSplitSummarize', 'getPendingCheckpoint',
    'resumePendingCheckpoint', 'discardPendingCheckpoint', 'endChapter', 'isSilentMergeRunning',
    'endChapterSilent', 'checkStaleSilentMerge',
];
for (const name of PUBLIC_EXPORTS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
    check('exports', `memories.js exports ${name}`, re.test(memories), 'public API must not be renamed or removed');
}
const NEW_EXPORTS = ['getMergeFloor', 'isArchiveIsolated', 'setArchiveIsolated', 'clearArchiveEntries', 'clearMergedStockedChunks', 'resolveMergeProfileId', 'resolveChunkProfileId', 'getProfileName'];
for (const name of NEW_EXPORTS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
    check('exports', `memories.js exports ${name}`, re.test(memories), 'required by the v3.3.0 plan');
}

// ------------------------------------------------------- profile routing
check('profile-routing', 'resolveChunkProfileId falls back stock_profile -> profile',
    /resolveChunkProfileId[\s\S]{0,240}stock_profile[\s\S]{0,120}settings\?\.profile|resolveChunkProfileId[\s\S]{0,240}stock_profile[\s\S]{0,120}settings\.profile/.test(memories),
    'chunk profile must fall back to the merge profile, then to the ST profile');
check('profile-routing', 'generateFromText picks the profile per pass',
    /isChunkPass[\s\S]{0,400}resolveChunkProfileId/.test(memories) && /resolveMergeProfileId/.test(memories),
    'the chunk pass must not reuse the merge profile');
check('profile-routing', 'no unconditional resolveConnectionProfileId(commandArgs?.profile, settings.profile) left in generateFromText',
    !/const profileId = resolveConnectionProfileId\(commandArgs\?\.profile, settings\.profile\)/.test(memories),
    'this was the original bug line');
check('profile-routing', 'stocking overrides chunkProfile, not profile',
    /chunkProfile:\s*settings\.stock_profile/.test(memories) && !/profile:\s*settings\.stock_profile/.test(memories),
    'autoStockChunks/regenerateStockedChunk must use commandArgs.chunkProfile');
check('profile-routing', 'stocking never mutates the global commandArgs',
    !/commandArgs = \{ quiet: !verbose/.test(memories) && !/commandArgs = previousArgs/.test(memories),
    'stocking owns a private job object, so a concurrent merge keeps its own profile');
check('profile-routing', 'progress reports the profile in use',
    /profile:\s*(chunkProfileName|mergeProfileName)/.test(memories) && /profile/.test(settingsJs.match(/export function updateChapterProgress[\s\S]{0,900}/)?.[0] || ''),
    'the progress bar should name the profile so the split is verifiable');

// ----------------------------------------------------- archive isolation
check('archive-isolation', 'per-chat metadata key exists', /fillTheTimeArchiveHidden/.test(memories));
check('archive-isolation', 'archive is hidden by default; only an explicit per-chat "shown" flag reveals it',
    /let archiveIsolated = true;/.test(memories) && /archiveIsolated\s*=\s*!context\.chatMetadata\[ARCHIVE_SHOWN_KEY\]/.test(memories),
    'default must be hidden (user requirement #6)');
const regenerationBody = memories.slice(memories.indexOf('export async function generateActiveSummaryReplacement'), memories.indexOf('export async function acceptActiveSummaryReplacement'));
const stockSegmentsBody = memories.slice(memories.indexOf('async function buildStockSegments'), memories.indexOf('function announceMergeScope'));
check('archive-isolation', 'regeneration always starts from message zero without archive state',
    /const base = null;/.test(regenerationBody) && /const start = 0;/.test(regenerationBody)
    && /previousSummary: ''/.test(regenerationBody)
    && !/archiveEntries|usableArchiveEntries/.test(regenerationBody));
check('archive-isolation', 'stock selection never receives archive state', !/archive/i.test(stockSegmentsBody));
check('archive-isolation', 'archive entries beyond the chat length are filtered',
    /endMsgId\s*<\s*chatLength|Number\(entry\.endMsgId\)\s*<\s*chatLength/.test(memories));
check('archive-isolation', 'restore is blocked while isolated',
    /archiveIsolated[\s\S]{0,200}return false/.test(memories.match(/export async function restorePreviousFromArchive[\s\S]{0,600}/)?.[0] || ''));
check('archive-isolation', 'obsolete merge and regeneration choices are removed from runtime and UI',
    !/merge_use_stock|merge_ignore_previous|use_archive_as_regen_base/.test(`${memories}\n${html}\n${commandsJs}`)
    && /merge_use_stock/.test(settingsJs.match(/const obsolete = \[[^\]]+\]/)?.[0] || ''));
check('archive-isolation', 'UI exposes the archive buttons',
    /rmr_archive_isolate/.test(html) && /rmr_archive_clear/.test(html) && /rmr_archive_isolate/.test(settingsJs) && /rmr_archive_clear/.test(settingsJs));
check('archive-isolation', 'slash commands cover archive control',
    /fillthetime-archive-hide/.test(commandsJs) && /fillthetime-archive-clear/.test(commandsJs));

// -------------------------------------------------------- stock hygiene
check('stock-hygiene', 'clear keeps stock and obsolete clear checkboxes are gone',
    !/dropMergedStock|dropAllStock/.test(memories) && !/rmr-drop-merged|rmr-drop-all/.test(html));
check('stock-hygiene', 'delete creates tombstone and purge is separate',
    /deleteStockedChunk[\s\S]{0,350}emptyChunk/.test(memories) && /export async function purgeStockedChunk/.test(memories));
check('stock-hygiene', 'stock merge blocks on empty chunk',
    /selected\.blockedBy/.test(memories) && /Regenerate it before merging/.test(memories));
check('stock-hygiene', 'clearStockedChunks also drops the pending checkpoint',
    /export async function clearStockedChunks[\s\S]{0,400}clearCheckpoint\(/.test(memories));
check('stock-hygiene', 'checkpoint resume is guarded by a stock fingerprint',
    /stockKey/.test(memories));
check('stock-hygiene', 'rolling merges always select eligible stock',
    /generateRollingSummary[\s\S]{0,900}await buildStockSegments/.test(memories)
    && !/generateRollingSummary[\s\S]{0,900}useStock/.test(memories));
check('stock-hygiene', 'merge scope is announced as one span, not a list of chunk boundaries',
    /function announceMergeScope/.test(memories)
    && (memories.match(/announceMergeScope\(/g) || []).length >= 3
    && !/usedRanges\.join/.test(memories),
    'both generators must report from-to once; per-chunk range listing must not come back');
check('stock-hygiene', 'merge scope is not announced twice',
    !/Using \$\{stockCount\} stocked chunk/.test(memories),
    'the old duplicate stock-count toast must stay removed');

// -------------------------------------------------------------- ui-ids
const markupIds = new Set();
for (const match of html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) markupIds.add(match[1]);
// ids created dynamically from JS string literals
for (const source of [settingsJs, memories, indexJs]) {
    for (const match of source.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) markupIds.add(match[1]);
    for (const match of source.matchAll(/\.id\s*=\s*'([a-zA-Z0-9_-]+)'/g)) markupIds.add(match[1]);
}
const referenced = new Set();
for (const source of [settingsJs, memories, indexJs, commandsJs]) {
    for (const match of source.matchAll(/[#$]\{?['"`]?#(rmr[a-zA-Z0-9_-]+)/g)) referenced.add(match[1]);
    for (const match of source.matchAll(/#(rmr_[a-zA-Z0-9_]+)/g)) referenced.add(match[1]);
}
for (const id of [...referenced].sort().filter(id => !id.endsWith('_'))) {
    check('ui-ids', `#${id} exists in markup`, markupIds.has(id), 'selector points at an element that is never created');
}

// ------------------------------------------------------- css alignment
check('css-alignment', 'shared field-row rules exist', /\.rmr-field-row/.test(css));
check('css-alignment', 'labels stretch so inputs align', /\.rmr-field label\s*\{[^}]*flex:\s*1/.test(css.replace(/\s+/g, ' ')) || /\.rmr-field-row \.rmr-field label\s*\{[^}]*flex:\s*1/.test(css.replace(/\s+/g, ' ')));
check('css-alignment', 'inputs fill the column', /\.rmr-field (?:select|input)[^{]*\{[^}]*width:\s*100%/.test(css.replace(/\s+/g, ' ')));
const rollingRow = html.match(/<div class="flex-container[^"]*"[^>]*>\s*<div[^>]*rmr_create_chapter_end[\s\S]{0,900}?<\/div>\s*<\/div>/)?.[0]
    || html.match(/rmr_create_chapter_end[\s\S]{0,900}rmr_split_stages[\s\S]{0,200}/)?.[0] || '';
check('css-alignment', 'End ID / Stages row uses .rmr-field', /rmr-field/.test(rollingRow), 'the two boxes must not size themselves from the label text');
check('css-alignment', 'End ID / Stages inputs are not widthNatural', !/widthNatural/.test(rollingRow));
check('css-alignment', 'connection row still even', /rmr-field/.test(html.match(/rmr_profile[\s\S]{0,900}rmr_rate_limit/)?.[0] || ''));
check('css-alignment', 'mobile stacking preserved', /max-width:700px/.test(css));

// --------------------------------------------------------- concurrency
check('concurrency', 'internal-generation flag is a depth counter, not a boolean',
    /let internalGenerationDepth = 0/.test(memories) && !/isInternalGeneration/.test(memories),
    'a boolean is cleared by whichever concurrent pass finishes first');
check('concurrency', 'macro and inject filter read the counter',
    /internalGenerationDepth > 0 \? ''/.test(memories) && /internalGenerationDepth === 0/.test(memories));
check('concurrency', 'generateFromText takes a per-request job',
    /async function generateFromText\([^)]*job = null\)/.test(memories) && /const args = job \|\| commandArgs/.test(memories),
    'stocking must not mutate the global commandArgs while a merge reads it');
const generateBody = memories.match(/async function generateFromText\([\s\S]*?\n\}/)?.[0] || '';
check('concurrency', 'generateFromText resolves the profile from the job, not the global',
    /resolveChunkProfileId\(args\?\.chunkProfile/.test(generateBody)
    && /resolveMergeProfileId\(args\?\.profile\)/.test(generateBody),
    'the request path must never read the shared commandArgs for routing');
check('concurrency', 'generateFromText touches the global only through the job fallback',
    generateBody.split('\n').filter(line => line.includes('commandArgs') && !line.trim().startsWith('//')).length === 1,
    'only `const args = job || commandArgs` may mention the global');
check('concurrency', 'stocking no longer overwrites commandArgs',
    !/commandArgs = \{ quiet: !verbose/.test(memories) && !/commandArgs = previousArgs/.test(memories),
    'the save/restore dance is replaced by a private job object');
check('concurrency', 'rate limiting is per profile and serialized',
    /const rateLimitChains = new Map\(\)/.test(memories) && /function rateLimitSlot/.test(memories) && !/lastGenerationTimestamp/.test(memories));
check('concurrency', 'stocking is not hard-blocked by a running merge',
    !/if \(endChapterInProgress\) \{ if \(verbose\) warningToast/.test(memories),
    'autoStockChunks must be allowed to run during a merge');
check('concurrency', 'stocking stays above the running merge target',
    /function mergeFloor/.test(memories) && /stockedChunks\.at\(-1\)\?\.toMsgId \?\? -1, mergeFloor\(\)\)/.test(memories),
    'a chunk inside the merge range would be summarized twice');
check('concurrency', 'a pre-existing stock plan is revalidated before and after each request',
    (memories.match(/protectedThrough = Math\.max\(rollingSummary\?\.endMsgId \?\? -1, mergeFloor\(\)\)/g) || []).length >= 2
    && /Discarding stale stocked chunk/.test(memories),
    'a merge can begin while a stock request is in flight; its result must then be discarded');
check('concurrency', 'every merge entry point reserves and releases its range',
    (memories.match(/beginMerge\(/g) || []).length >= 5 && (memories.match(/endMerge\(\)/g) || []).length >= 5);
check('concurrency', 'destructive restock still blocked during a merge',
    /if \(isMergeRunning\(\)\) \{ rawWarn/.test(memories));
check('concurrency', 'chunk regeneration refuses chunks inside the merge range',
    /Number\(fromMsgId\) <= mergeFloor\(\)/.test(memories));
check('concurrency', 'stocking toasts bypass the shared quiet flag',
    /const rawInfo = text =>/.test(memories) && /const rawWarn = text =>/.test(memories));
check('concurrency', 'concurrency can be turned off',
    !/stock_during_merge/.test(memories) && !/rmr_stock_during_merge/.test(html),
    'concurrency is always on; the toggle was removed in v4');

// -------------------------------------------------- prompt substitution
check('prompt-substitution', 'summarization macros are filled in one pass via a callback',
    memories.includes('{{(content|previousSummary|previous_summary|worldInfo)}}/gi, (match, key)') && memories.includes('const fillMacros ='),
    'chained replaces rescan inserted text and reinterpret $-directives inside it');
check('prompt-substitution', 'injection macros are filled in one pass via a callback',
    memories.includes('{{(fillthetime|lastMessageId|firstIncludedMessageId)}}/gi, (match, key)'));
for (const [macro, snippet] of [
    ['{{content}}', 'replace(/{{content}}/gi,'],
    ['{{previousSummary}}', 'replace(/{{previousSummary}}/gi,'],
    ['{{worldinfo}}', 'replace(/{{worldinfo}}/gi,'],
    ['{{fillthetime}}', 'replace(/{{fillthetime}}/gi,'],
]) {
    check('prompt-substitution', `no string-form replacement left for ${macro}`, !memories.includes(snippet),
        'a value containing $& or $` would be treated as a replacement directive');
}
check('prompt-substitution', 'world info is only fetched when a template asks for it',
    memories.includes('needsWorldInfo ? await getWorldInfoText() :'),
    'the old helper short-circuited; the single pass must keep that');
check('prompt-substitution', 'the superseded two-step world info helper is gone',
    !memories.includes('substituteWorldInfo'));
check('prompt-substitution', 'the executable prompt test ships with the extension',
    existsSync(join(root, 'tools/test-prompts.mjs')),
    'static checks cannot prove what the model actually receives');

// ------------------------------------------------------------ v4 routing
check('v4-routing', 'chunk pass always uses the chunk prompts (no toggle)',
    /const useChunkPrompts = isChunkPass;/.test(memories) && !/use_custom_chunk_prompts/.test(memories) && !/use_custom_chunk_prompts/.test(settingsJs.split('const obsolete')[0]),
    'chunk digests must never be produced with the merge prompt');
check('v4-routing', 'no silent fallback to the chat API',
    !/generateQuietPrompt/.test(memories),
    'a broken summarization profile must fail loudly, never leak onto the chat connection');
check('v4-routing', 'finish_reason is read from the raw response',
    /extractData:\s*false/.test(memories) && /function extractFinishReason/.test(memories));
check('v4-routing', 'per-pass max tokens are honoured',
    /settings\.merge_max_tokens/.test(memories) && /settings\.chunk_max_tokens/.test(memories) && /merge_max_tokens/.test(settingsJs));
check('v4-routing', 'truncated merges are continued, never auto-accepted',
    /CONTINUATION_PROMPT/.test(memories) && /lastGenerationTruncated/.test(memories.match(/export async function endChapterSilent[\s\S]*?\n\}/)?.[0] || ''),
    'a cut-off summary must go to review instead of overwriting the active summary');
check('v4-routing', 'hidden messages carry an ownership marker',
    /extra\.fillTheTimeHidden = true/.test(memories) && /message\?\.extra\?\.fillTheTimeHidden/.test(memories),
    'Clear/Restore must not unhide messages the user hid by hand');
check('v4-routing', 'no chat message insertion (/comment) remains',
    !/\/comment at=/.test(memories) && !/pendingChunkComments/.test(memories) && !/add_chunk_summaries/.test(html),
    'inserting a message shifts every later chunk id');
check('v4-routing', 'checkpoint fingerprint hashes content',
    /function fingerprint/.test(memories) && !/s:\$\{item\.text\.length\}/.test(memories));
check('v4-routing', 'archive is hidden by default per chat',
    /let archiveIsolated = true;/.test(memories) && /fillTheTimeArchiveShown/.test(memories));

// ---------------------------------------------------------------- i18n
const REQUIRED_KEYS = [
    'rmr_merge_profile', 'rmr_chunk_profile',
    'rmr_archive_hide', 'rmr_archive_show', 'rmr_archive_clear_all', 'rmr_archive_hidden_note',
    'rmr_archive_clear_confirm', 'rmr_stock_delete_all', 'rmr_stock_delete_merged',
    'rmr_merge_max_tokens', 'rmr_chunk_max_tokens', 'rmr_merge_continuations',
];
for (const locale of ['vi-vn', 'fr-fr']) {
    let data = {};
    try { data = JSON.parse(read(`locales/${locale}.json`)); } catch { /* reported by syntax group */ }
    const missing = REQUIRED_KEYS.filter(key => !data[key]);
    check('i18n', `${locale} has the new keys`, missing.length === 0, `missing: ${missing.join(', ')}`);
}
const manifest = JSON.parse(read('manifest.json'));
check('i18n', 'manifest version bumped to >= 3.3.0',
    manifest.version.split('.').map(Number).reduce((acc, part, index) => acc + part * [10000, 100, 1][index], 0) >= 30300,
    `found ${manifest.version}`);

// --------------------------------------------------------------- report
const groups = [...new Set(results.map(item => item.group))].filter(group => !onlyGroup || group === onlyGroup);
let failed = 0;
for (const group of groups) {
    const items = results.filter(item => item.group === group);
    const bad = items.filter(item => !item.ok);
    console.log(`\n[${bad.length ? 'FAIL' : ' OK ' }] ${group}  (${items.length - bad.length}/${items.length})`);
    for (const item of bad) console.log(`   x ${item.name}${item.hint ? `  -- ${item.hint}` : ''}`);
    failed += bad.length;
}
console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}\n`);
process.exit(failed ? 1 : 0);
