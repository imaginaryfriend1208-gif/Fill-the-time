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

/**
 * Split messages into chunk pieces without ever cutting a message. A piece closes before the
 * message that would push it past `maxTokens`; a single message larger than `maxTokens` becomes
 * its own piece. When `minTokens` > 0, a trailing piece that already reached `minTokens` is
 * complete too; otherwise it stays as `tail` until a later message closes it.
 * `entries` are `{ text, index }`; `countTokens(text)` may be sync or async.
 */
export async function planChunks(entries, countTokens, { maxTokens, minTokens = 0 } = {}) {
    const max = Math.max(1, Number(maxTokens) || 1);
    const min = Math.min(max, Math.max(0, Number(minTokens) || 0));
    const pieces = [];
    let current = null;
    for (const { text, index } of Array.isArray(entries) ? entries : []) {
        const candidate = current ? `${current.text}\n\n${text}` : text;
        const tokens = await countTokens(candidate);
        if (tokens <= max) { current = current ? { ...current, text: candidate, endId: index, tokens } : { text, startId: index, endId: index, tokens }; continue; }
        if (current) pieces.push(current);
        const own = current ? await countTokens(text) : tokens;
        if (own > max) { pieces.push({ text, startId: index, endId: index, tokens: own }); current = null; }
        else current = { text, startId: index, endId: index, tokens: own };
    }
    if (current && min > 0 && current.tokens >= min) { pieces.push(current); current = null; }
    return { pieces, tail: current };
}
