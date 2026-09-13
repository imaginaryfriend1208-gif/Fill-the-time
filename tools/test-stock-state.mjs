#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectChunksForMerge } from '../src/chunk-select.js';
import { CHUNK_STATUS, deriveChunkStatus, emptyChunk } from '../src/summary-state.js';

let failures = 0;
let assertions = 0;
function check(name, condition, detail = '') {
    assertions++;
    if (condition) console.log(`pass  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const chunk = (fromMsgId, toMsgId, summary = `summary ${fromMsgId}-${toMsgId}`) => ({ fromMsgId, toMsgId, summary });

console.log('\n-- derived status --');
check('empty summary is empty', deriveChunkStatus(chunk(0, 9, '')) === CHUNK_STATUS.EMPTY);
check('missing summary is empty', deriveChunkStatus({ fromMsgId: 0, toMsgId: 9 }) === CHUNK_STATUS.EMPTY);
check('chunk ending at active boundary is merged', deriveChunkStatus(chunk(0, 9), 9) === CHUNK_STATUS.MERGED);
check('chunk below active boundary is merged', deriveChunkStatus(chunk(0, 9), 20) === CHUNK_STATUS.MERGED);
check('chunk above active boundary is pending', deriveChunkStatus(chunk(10, 19), 9) === CHUNK_STATUS.PENDING);
check('chunk crossing active boundary overlaps', deriveChunkStatus(chunk(5, 15), 9) === CHUNK_STATUS.OVERLAP);
check('chunk crossing merge floor overlaps', deriveChunkStatus(chunk(10, 20), 5, 15) === CHUNK_STATUS.OVERLAP);
check('chunk above merge floor is pending', deriveChunkStatus(chunk(16, 20), 5, 15) === CHUNK_STATUS.PENDING);
const retained = [chunk(0, 65), chunk(66, 130), chunk(131, 190)];
const retainedLength = retained.length;
check('chunks are merged at active end 250', retained.every(item => deriveChunkStatus(item, 250) === CHUNK_STATUS.MERGED));
check('chunks become pending when active summary clears', retained.every(item => deriveChunkStatus(item, -1) === CHUNK_STATUS.PENDING));
check('derivation never changes array length', retained.length === retainedLength);
const tombstoned = retained.map((item, index) => index === 1 ? emptyChunk(item, '2026-09-13T00:00:00.000Z') : item);
check('emptying middle chunk preserves array length', tombstoned.length === retained.length);
check('emptied middle chunk has empty status', deriveChunkStatus(tombstoned[1], -1) === CHUNK_STATUS.EMPTY);
check('emptying does not mutate original chunk', retained[1].summary === 'summary 66-130');
check('tombstone records emptiedAt', tombstoned[1].emptiedAt === '2026-09-13T00:00:00.000Z');
const blockedChain = selectChunksForMerge(tombstoned, -1, 190);
check('merge across tombstone is blocked', blockedChain.blockedBy === tombstoned[1]);
check('blocked middle range is reported', blockedChain.blockedBy?.fromMsgId === 66 && blockedChain.blockedBy?.toMsgId === 130);

console.log('\n-- merge selection --');
let result = selectChunksForMerge(retained, 250, 300);
check('old chunks do not leak into a later merge', result.usedStock === 0, JSON.stringify(result));
check('later merge has one raw range', result.segments.length === 1);
check('later raw range starts after oldEnd', result.segments[0]?.fromMsgId === 251);
check('later raw range ends at target', result.segments[0]?.toMsgId === 300);
result = selectChunksForMerge([chunk(0, 9), chunk(10, 19)], -1, 19);
check('two contiguous chunks are selected', result.usedStock === 2);
check('two contiguous chunks make two segments', result.segments.length === 2);
check('stock text is preserved', result.segments[1]?.stock === 'summary 10-19');
check('successful selection has no blocker', result.blockedBy === null);
result = selectChunksForMerge([chunk(0, 9), chunk(20, 29)], -1, 29);
check('gap produces a raw segment', result.segments[1]?.fromMsgId === 10 && result.segments[1]?.toMsgId === 19);
check('gap selection still uses both chunks', result.usedStock === 2);
result = selectChunksForMerge([chunk(0, 9), chunk(10, 19, ''), chunk(20, 29)], -1, 29);
check('empty chunk blocks selection', result.blockedBy?.fromMsgId === 10 && result.blockedBy?.toMsgId === 19);
check('blocked selection returns no segments', result.segments.length === 0);
check('blocked selection reports no reusable stock', result.usedStock === 0);
result = selectChunksForMerge([chunk(0, 9), chunk(10, 30)], -1, 20);
check('chunk extending beyond target is ignored', result.usedStock === 1);
check('ignored tail becomes raw history', result.segments.at(-1)?.fromMsgId === 10 && result.segments.at(-1)?.toMsgId === 20);
result = selectChunksForMerge([], 4, 8);
check('empty stock produces raw range', result.segments[0]?.fromMsgId === 5 && result.segments[0]?.toMsgId === 8);
result = selectChunksForMerge(null, 4, 4);
check('empty merge range produces no segment', result.segments.length === 0);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const selectorSource = readFileSync(join(root, 'src/chunk-select.js'), 'utf8').toLowerCase();
check('selector has no archive input or dependency', !selectorSource.includes('archive'));
check('at least 20 assertions executed', assertions >= 20, String(assertions));
console.log(failures ? `\n${failures}/${assertions} assertion(s) failed\n` : `\nAll ${assertions} stock-state assertions passed\n`);
process.exit(failures ? 1 : 0);
