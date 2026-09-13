const active = new Map();
const toast = () => globalThis.toastr;

function clear(lane) {
    const handle = active.get(lane);
    if (handle) toast()?.clear?.(handle);
    active.delete(lane);
}

export const notify = {
    progress(lane, text) {
        clear(lane);
        const handle = toast()?.info?.(text, 'IF Memory', { timeOut: 0, extendedTimeOut: 0 });
        if (handle) active.set(lane, handle);
        return handle;
    },
    done(lane, text) { clear(lane); return toast()?.success?.(text, 'IF Memory'); },
    error(lane, text) { clear(lane); return toast()?.error?.(text, 'IF Memory'); },
    clear,
};

if (toast()) toast().options = { ...toast().options, preventDuplicates: true, timeOut: 6000, extendedTimeOut: 2000, newestOnTop: true };
