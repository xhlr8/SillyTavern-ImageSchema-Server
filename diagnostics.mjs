import { createHash } from 'node:crypto';

const LEVELS = new Set(['info', 'warn', 'error']);
const CACHE_RESULTS = new Set(['hit', 'miss', 'bypass', 'error']);
const SAFE_LABEL = /^[A-Za-z0-9_.-]{1,100}$/;
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 200;

function safeLabel(value) {
    return typeof value === 'string' && SAFE_LABEL.test(value) ? value : undefined;
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function publicEvent(event) {
    const { scope: _scope, ...result } = event;
    return { ...result };
}

/**
 * A process-local, deliberately low-detail activity log. Only fields explicitly
 * copied below can enter the buffer. In particular, messages, request content,
 * URLs, headers, bodies, credentials, and Error objects are always discarded.
 */
export class ActivityDiagnostics {
    constructor({ limit = DEFAULT_LIMIT, now = () => new Date() } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            throw new TypeError(`diagnostics limit must be an integer from 1 to ${MAX_LIMIT}`);
        }
        this.limit = limit;
        this.now = now;
        this.buffer = new Array(limit);
        this.size = 0;
        this.next = 0;
    }

    record(input = {}) {
        const event = safeLabel(input.event);
        if (!event) return null;
        const timestampValue = this.now();
        const timestamp = timestampValue instanceof Date && !Number.isNaN(timestampValue.valueOf())
            ? timestampValue.toISOString()
            : new Date().toISOString();
        const entry = {
            timestamp,
            level: LEVELS.has(input.level) ? input.level : 'info',
            event,
        };
        const action = safeLabel(input.action);
        const profile = safeLabel(input.profile);
        const code = safeLabel(input.code);
        const requestId = safeLabel(input.requestId);
        const stage = safeLabel(input.stage);
        const outcome = safeLabel(input.outcome);
        const source = safeLabel(input.source);
        const mime = safeLabel(String(input.mime ?? '').replace('/', '_'));
        const durationMs = safeInteger(Math.round(Number(input.durationMs)), { maximum: 86_400_000 });
        const status = safeInteger(input.status, { minimum: 100, maximum: 599 });
        const bytes = safeInteger(input.bytes);
        const count = safeInteger(input.count);
        if (action) entry.action = action;
        if (profile) entry.profile = profile;
        if (CACHE_RESULTS.has(input.cache)) entry.cache = input.cache;
        if (durationMs !== undefined) entry.durationMs = durationMs;
        if (status !== undefined) entry.status = status;
        if (code) entry.code = code;
        if (requestId) entry.requestId = requestId;
        if (stage) entry.stage = stage;
        if (outcome) entry.outcome = outcome;
        if (source) entry.source = source;
        if (mime) entry.mime = mime;
        if (bytes !== undefined) entry.bytes = bytes;
        if (count !== undefined) entry.count = count;
        entry.scope = safeLabel(input.scope) ?? 'anonymous';
        this.#append(entry);
        return publicEvent(entry);
    }

    recent({ scope, global = false, limit = this.limit } = {}) {
        const count = Math.min(this.limit, Math.max(1, safeInteger(limit, { minimum: 1, maximum: this.limit }) ?? this.limit));
        const selected = this.#ordered().filter(entry => global || entry.scope === (safeLabel(scope) ?? 'anonymous'));
        return selected.slice(-count).map(publicEvent);
    }

    summary({ scope, global = false } = {}) {
        const events = this.#ordered().filter(entry => global || entry.scope === (safeLabel(scope) ?? 'anonymous'));
        const result = { total: events.length, levels: {}, events: {}, cache: {}, codes: {} };
        for (const entry of events) {
            result.levels[entry.level] = (result.levels[entry.level] ?? 0) + 1;
            result.events[entry.event] = (result.events[entry.event] ?? 0) + 1;
            if (entry.cache) result.cache[entry.cache] = (result.cache[entry.cache] ?? 0) + 1;
            if (entry.code) result.codes[entry.code] = (result.codes[entry.code] ?? 0) + 1;
        }
        return result;
    }

    clear({ scope, global = false } = {}) {
        if (global) {
            const removed = this.size;
            this.buffer = new Array(this.limit);
            this.size = 0;
            this.next = 0;
            return removed;
        }
        const selectedScope = safeLabel(scope) ?? 'anonymous';
        const retained = this.#ordered().filter(entry => entry.scope !== selectedScope);
        const removed = this.size - retained.length;
        this.buffer = new Array(this.limit);
        this.size = 0;
        this.next = 0;
        for (const entry of retained) this.#append(entry);
        return removed;
    }

    #append(entry) {
        this.buffer[this.next] = entry;
        this.next = (this.next + 1) % this.limit;
        this.size = Math.min(this.size + 1, this.limit);
    }

    #ordered() {
        const result = [];
        const start = (this.next - this.size + this.limit) % this.limit;
        for (let index = 0; index < this.size; index++) result.push(this.buffer[(start + index) % this.limit]);
        return result;
    }
}

export function diagnosticsScope(request) {
    const identity = String(request?.user?.profile?.handle ?? request?.user?.id ?? 'anonymous');
    return createHash('sha256').update(identity).digest('hex');
}

export function isDiagnosticsAdmin(request) {
    return request?.user?.profile?.admin === true;
}

export function recordDiagnostic(diagnostics, event) {
    try {
        return diagnostics?.record(event) ?? null;
    } catch {
        return null;
    }
}

export const diagnosticsContract = Object.freeze({
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
    fields: Object.freeze(['timestamp', 'level', 'event', 'action', 'profile', 'cache', 'durationMs', 'status', 'code', 'bytes', 'requestId', 'stage', 'outcome', 'source', 'mime', 'count']),
});
