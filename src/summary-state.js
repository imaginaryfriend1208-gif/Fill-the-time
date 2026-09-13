export const CHUNK_STATUS = Object.freeze({
    EMPTY: 'empty',
    MERGED: 'merged',
    PENDING: 'pending',
    OVERLAP: 'overlap',
});

/** Derive transient chunk state from the active summary and in-flight merge boundaries. */
export function deriveChunkStatus(chunk, activeEnd = -1, mergeFloor = -1) {
    if (!chunk?.summary) return CHUNK_STATUS.EMPTY;
    if (chunk.toMsgId <= activeEnd) return CHUNK_STATUS.MERGED;
    const protectedThrough = Math.max(activeEnd, mergeFloor);
    if (chunk.fromMsgId <= protectedThrough && chunk.toMsgId > protectedThrough) return CHUNK_STATUS.OVERLAP;
    return CHUNK_STATUS.PENDING;
}

/** Return a tombstone copy without changing array membership. */
export function emptyChunk(chunk, emptiedAt = new Date().toISOString()) {
    return { ...chunk, summary: '', emptiedAt };
}
