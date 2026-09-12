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

// ---------------------------------------------------------------- exports
const PUBLIC_EXPORTS = [
    'getRollingSummary', 'getArchiveEntries', 'getStockedChunks', 'loadRollingSummaryData',
    'deleteArchiveEntry', 'updateRollingSummaryText', 'restorePreviousFromArchive', 'clearRollingSummary',
    'initFillTheTimeMacros', 'updateSummaryInjection', 'isValidConnectionProfileId', 'resolveConnectionProfileId',
    'getReasoningEffort', 'getIncludeReasoning', 'getMaxTokensForProfile', 'buildOverridePayload',
    'isStocking', 'invalidateStockFrom', 'clearStockedChunks', 'deleteStockedChunk', 'regenerateStockedChunk',
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
const NEW_EXPORTS = ['isArchiveIsolated', 'setArchiveIsolated', 'clearArchiveEntries', 'clearMergedStockedChunks', 'resolveMergeProfileId', 'resolveChunkProfileId', 'getProfileName'];
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
check('profile-routing', 'commandArgs is restored after stocking',
    (memories.match(/commandArgs = previousArgs/g) || []).length >= 2,
    'global commandArgs must not leak the stock profile into later merges');
check('profile-routing', 'progress reports the profile in use',
    /profile:\s*(chunkProfileName|mergeProfileName)/.test(memories) && /profile/.test(settingsJs.match(/export function updateChapterProgress[\s\S]{0,900}/)?.[0] || ''),
    'the progress bar should name the profile so the split is verifiable');

// ----------------------------------------------------- archive isolation
check('archive-isolation', 'per-chat metadata key exists', /fillTheTimeArchiveHidden/.test(memories));
check('archive-isolation', 'isolation state is loaded on chat load',
    /archiveIsolated\s*=\s*Boolean\(/.test(memories));
check('archive-isolation', 'regeneration can skip the archive base',
    /ignoreArchive/.test(memories) && /use_archive_as_regen_base/.test(memories),
    'generateActiveSummaryReplacement must honour isolation + the global setting');
check('archive-isolation', 'archive entries beyond the chat length are filtered',
    /endMsgId\s*<\s*chatLength|Number\(entry\.endMsgId\)\s*<\s*chatLength/.test(memories));
check('archive-isolation', 'restore is blocked while isolated',
    /archiveIsolated[\s\S]{0,200}return false/.test(memories.match(/export async function restorePreviousFromArchive[\s\S]{0,600}/)?.[0] || ''));
check('archive-isolation', 'fresh merge option exists', /ignorePrevious/.test(memories));
check('archive-isolation', 'UI exposes the archive buttons',
    /rmr_archive_isolate/.test(html) && /rmr_archive_clear/.test(html) && /rmr_archive_isolate/.test(settingsJs) && /rmr_archive_clear/.test(settingsJs));
check('archive-isolation', 'slash commands cover archive control',
    /fillthetime-archive-hide/.test(commandsJs) && /fillthetime-archive-clear/.test(commandsJs));

// -------------------------------------------------------- stock hygiene
check('stock-hygiene', 'clearing the summary drops merged chunks',
    /dropMergedStock/.test(memories));
check('stock-hygiene', 'clearStockedChunks also drops the pending checkpoint',
    /export async function clearStockedChunks[\s\S]{0,400}clearCheckpoint\(/.test(memories));
check('stock-hygiene', 'checkpoint resume is guarded by a stock fingerprint',
    /stockKey/.test(memories));
check('stock-hygiene', 'useStock can be turned off from the UI',
    /merge_use_stock/.test(settingsJs) && /rmr_merge_use_stock/.test(html));
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

// ---------------------------------------------------------------- i18n
const REQUIRED_KEYS = [
    'rmr_merge_profile', 'rmr_chunk_profile', 'rmr_merge_use_stock', 'rmr_merge_ignore_previous',
    'rmr_archive_hide', 'rmr_archive_show', 'rmr_archive_clear_all', 'rmr_archive_hidden_note',
    'rmr_archive_clear_confirm', 'rmr_use_archive_as_regen_base', 'rmr_stock_delete_all', 'rmr_stock_delete_merged',
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
