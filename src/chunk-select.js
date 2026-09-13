/**
 * Select stocked chunks wholly contained in (oldEnd, target]. History segments are ranges
 * which the caller may resolve asynchronously. An empty selected chunk blocks the merge.
 */
export function selectChunksForMerge(chunks, oldEnd, target) {
    const segments = [];
    let cursor = Number(oldEnd) + 1;
    let usedStock = 0;

    for (const chunk of Array.isArray(chunks) ? chunks : []) {
        if (!chunk || chunk.toMsgId < cursor || chunk.fromMsgId < cursor) continue;
        if (chunk.fromMsgId > target) break;
        if (chunk.toMsgId > target) continue;
        if (!chunk.summary) return { segments: [], usedStock: 0, blockedBy: chunk };
        if (chunk.fromMsgId > cursor) segments.push({ fromMsgId: cursor, toMsgId: chunk.fromMsgId - 1 });
        segments.push({ stock: chunk.summary, fromMsgId: chunk.fromMsgId, toMsgId: chunk.toMsgId });
        cursor = chunk.toMsgId + 1;
        usedStock++;
    }

    if (cursor <= target) segments.push({ fromMsgId: cursor, toMsgId: target });
    return { segments, usedStock, blockedBy: null };
}
