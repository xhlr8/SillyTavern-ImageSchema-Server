import { randomUUID } from 'node:crypto';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATES = new Set(['queued', 'resolving', 'provider-running', 'persisting']);
const EXECUTION_STATES = new Set(['resolving', 'provider-running', 'persisting']);
const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(label + ' must be a positive integer');
    return number;
}

function publicError(error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'generation_failed';
    const message = typeof error?.code === 'string' && typeof error?.message === 'string' && error.message
        ? error.message : 'Generation job failed';
    return { code, message };
}

const clone = value => structuredClone(value);
const timestamp = milliseconds => new Date(milliseconds).toISOString();
const abortError = message => new DOMException(message, 'AbortError');

/** Process-local, authenticated-owner-scoped FIFO generation queue. */
export class GenerationJobQueue {
    constructor({ concurrency = 1, retentionMs = DEFAULT_RETENTION_MS, executor, now = Date.now } = {}) {
        this.concurrency = positiveInteger(concurrency, 'jobs.concurrency');
        this.retentionMs = positiveInteger(retentionMs, 'jobs.retentionMs');
        if (typeof executor !== 'function') throw new TypeError('executor must be a function');
        this.executor = executor;
        this.now = now;
        this.jobs = new Map();
        this.pending = [];
        this.running = 0;
        this.sequence = 0;
        this.closed = false;
        this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(this.retentionMs, 60_000));
        this.cleanupTimer.unref?.();
    }

    create(owner, input) {
        if (this.closed) throw new Error('Generation job queue is closed');
        this.cleanup();
        const now = this.now();
        const job = {
            jobId: randomUUID(), owner: String(owner), sequence: this.sequence++, state: 'queued',
            chatId: input.chatId, messageId: input.messageId, swipeKey: input.swipeKey, slotId: input.slotId,
            action: input.action, request: clone(input.request), result: null, error: null,
            createdAt: timestamp(now), updatedAt: timestamp(now), startedAt: null, finishedAt: null,
            terminalAt: null, controller: new AbortController(),
        };
        this.jobs.set(job.jobId, job);
        this.pending.push(job.jobId);
        queueMicrotask(() => this.#pump());
        return this.#public(job);
    }

    list(owner) {
        this.cleanup();
        return [...this.jobs.values()].filter(job => job.owner === String(owner))
            .sort((a, b) => b.sequence - a.sequence).map(job => this.#public(job));
    }

    get(owner, id) {
        this.cleanup();
        const job = this.jobs.get(String(id));
        return job?.owner === String(owner) ? this.#public(job) : null;
    }

    cancel(owner, id) {
        this.cleanup();
        const job = this.jobs.get(String(id));
        if (!job || job.owner !== String(owner)) return null;
        if (TERMINAL_STATES.has(job.state)) return { cancelled: job.state === 'cancelled', job: this.#public(job) };
        job.controller.abort(abortError('Generation job cancelled'));
        this.#transition(job, 'cancelled');
        const index = this.pending.indexOf(job.jobId);
        if (index !== -1) this.pending.splice(index, 1);
        return { cancelled: true, job: this.#public(job) };
    }

    cleanup(at = this.now()) {
        const cutoff = at - this.retentionMs;
        let removed = 0;
        for (const [id, job] of this.jobs) if (job.terminalAt !== null && job.terminalAt <= cutoff) {
            this.jobs.delete(id); removed++;
        }
        return removed;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.cleanupTimer);
        for (const job of this.jobs.values()) if (ACTIVE_STATES.has(job.state)) {
            job.controller.abort(abortError('Generation job queue stopped'));
            this.#transition(job, 'cancelled');
        }
        this.pending.length = 0;
    }

    #pump() {
        if (this.closed) return;
        while (this.running < this.concurrency && this.pending.length) {
            const job = this.jobs.get(this.pending.shift());
            if (!job || job.state !== 'queued') continue;
            this.running++;
            void this.#run(job).finally(() => { this.running--; this.#pump(); });
        }
    }

    async #run(job) {
        this.#transition(job, 'resolving');
        try {
            const result = await this.executor({
                jobId: job.jobId, owner: job.owner, action: job.action, request: clone(job.request),
                signal: job.controller.signal,
                updateState: state => {
                    if (!EXECUTION_STATES.has(state)) throw new TypeError('Unsupported job state: ' + state);
                    if (!TERMINAL_STATES.has(job.state)) this.#transition(job, state);
                },
            });
            if (job.controller.signal.aborted || job.state === 'cancelled') return;
            job.result = clone(result);
            this.#transition(job, 'completed');
        } catch (error) {
            if (job.controller.signal.aborted || error?.name === 'AbortError') {
                if (job.state !== 'cancelled') this.#transition(job, 'cancelled');
            } else {
                job.error = publicError(error);
                this.#transition(job, 'failed');
            }
        }
    }

    #transition(job, state) {
        if (TERMINAL_STATES.has(job.state)) return;
        const now = this.now();
        job.state = state;
        job.updatedAt = timestamp(now);
        if (EXECUTION_STATES.has(state) && job.startedAt === null) job.startedAt = job.updatedAt;
        if (TERMINAL_STATES.has(state)) { job.finishedAt = job.updatedAt; job.terminalAt = now; }
    }

    #public(job) {
        return {
            jobId: job.jobId, state: job.state, chatId: job.chatId, messageId: job.messageId,
            swipeKey: job.swipeKey, slotId: job.slotId, action: job.action,
            createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
            ...(job.result === null ? {} : { result: clone(job.result) }),
            ...(job.error === null ? {} : { error: { ...job.error } }),
        };
    }
}

export const generationJobContract = Object.freeze({
    states: Object.freeze(['queued', 'resolving', 'provider-running', 'persisting', 'completed', 'failed', 'cancelled']),
    retentionMs: DEFAULT_RETENTION_MS,
    defaultConcurrency: 1,
});
