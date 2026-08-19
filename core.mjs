import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recordDiagnostic } from './diagnostics.mjs';
import { applyComfyBindings, validateComfyBindings, validateComfyWorkflow } from './comfyui.mjs';

export const INSTRUCTION_PROMPT_MAX_LENGTH = 20_000;

export class PluginError extends Error {
    constructor(message, { status = 502, code = 'upstream_error', cause } = {}) {
        super(message, { cause });
        this.name = 'PluginError';
        this.status = status;
        this.code = code;
    }
}

export function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function fingerprint(value) {
    return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function expandEnv(value, env = process.env) {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
            if (Object.hasOwn(env, name)) return env[name];
            if (fallback !== undefined) return fallback;
            throw new PluginError(`Required environment variable ${name} is not set`, { status: 500, code: 'config_error' });
        });
    }
    if (Array.isArray(value)) return value.map(item => expandEnv(item, env));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item, env)]));
    }
    return value;
}

export function renderTemplate(value, context, { encodePrompt = false } = {}) {
    if (typeof value === 'string') {
        const exact = value.match(/^\{([A-Za-z][A-Za-z0-9_]*)\}$/);
        if (exact) {
            const found = context[exact[1]];
            if (found === undefined || found === null || found === '') return undefined;
            return found;
        }
        return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
            const found = context[key];
            if (found === undefined || found === null) return '';
            return encodePrompt && key === 'prompt' ? encodeURIComponent(String(found)) : String(found);
        });
    }
    if (Array.isArray(value)) return value.map(item => renderTemplate(item, context, { encodePrompt })).filter(item => item !== undefined);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            const rendered = renderTemplate(item, context, { encodePrompt });
            if (rendered !== undefined) result[key] = rendered;
        }
        return result;
    }
    return value;
}

export function getJsonPath(value, expression) {
    if (!expression) return value;
    const tokens = String(expression).match(/[^.[\]]+/g) ?? [];
    let current = value;
    for (const token of tokens) {
        if (current === null || current === undefined || !Object.hasOwn(Object(current), token)) {
            throw new PluginError(`Response path not found: ${expression}`, { code: 'invalid_upstream_response' });
        }
        current = current[token];
    }
    return current;
}

export function sniffMime(data, hint = '') {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif';
    const normalizedHint = String(hint).split(';', 1)[0].trim().toLowerCase();
    if (normalizedHint === 'image/svg+xml' && /<svg[\s>]/i.test(bytes.toString('utf8', 0, Math.min(bytes.length, 512)))) return normalizedHint;
    throw new PluginError(`Upstream did not return a recognized image${hint ? ` (declared ${normalizedHint})` : ''}`, { code: 'invalid_upstream_response' });
}

function decodeImage(value, encoding = 'base64') {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value !== 'string') throw new PluginError('Image response value is not a string', { code: 'invalid_upstream_response' });
    if (value.startsWith('data:')) {
        const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (!match) throw new PluginError('Invalid image data URL', { code: 'invalid_upstream_response' });
        return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    }
    if (encoding === 'base64') return Buffer.from(value, 'base64');
    if (encoding === 'url') return value;
    throw new PluginError(`Unsupported response encoding: ${encoding}`, { status: 500, code: 'config_error' });
}

function openAiSize(width, height, model = '') {
    if (String(model).startsWith('gpt-image-2')) return `${width}x${height}`;
    const ratio = width / height;
    if (ratio > 1.2) return '1536x1024';
    if (ratio < 0.8) return '1024x1536';
    return '1024x1024';
}

function combineSignal(timeoutMs, externalSignal) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

async function checkedFetch(url, options, profile, fetchImpl, activity = {}) {
    const startedAt = Date.now();
    const diagnostic = fields => recordDiagnostic(activity.diagnostics, {
        event: 'upstream.request',
        action: String(options.method ?? 'GET').toLowerCase(),
        profile: activity.profile,
        scope: activity.scope,
        durationMs: Date.now() - startedAt,
        ...fields,
    });
    let response;
    try {
        response = await fetchImpl(url, {
            ...options,
            redirect: 'follow',
            signal: combineSignal(Number(profile.timeoutMs ?? 180000), options.signal),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            diagnostic({ level: 'error', status: 504, code: 'timeout' });
            throw new PluginError('Upstream image request timed out', { status: 504, code: 'timeout', cause: error });
        }
        diagnostic({ level: 'error', status: 502, code: 'connection_error' });
        throw new PluginError('Upstream image request failed', { status: 502, code: 'connection_error', cause: error });
    }
    if (!response.ok) {
        const text = await responseBuffer(response, 64 * 1024).then(data => data.toString('utf8')).catch(() => '');
        const status = response.status === 429 ? 429 : response.status >= 400 && response.status < 500 ? 400 : 502;
        const code = response.status === 429 ? 'rate_limit' : response.status === 400 || /safety|policy|moderation|blocked|filter|bad object/i.test(text) ? 'safety' : 'upstream_error';
        diagnostic({ level: 'error', status: response.status, code });
        throw new PluginError(`Upstream HTTP ${response.status}`, { status, code });
    }
    diagnostic({ status: response.status });
    return response;
}

async function responseBuffer(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (declared && declared > maxBytes) throw new PluginError('Upstream response exceeds configured size limit', { code: 'response_too_large' });
    if (!response.body?.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new PluginError('Upstream response exceeds configured size limit', { code: 'response_too_large' });
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new PluginError('Upstream response exceeds configured size limit', { code: 'response_too_large' });
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

async function responseJson(response, maxBytes, label) {
    try { return JSON.parse((await responseBuffer(response, maxBytes)).toString('utf8')); }
    catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError(`${label} response was not JSON`, { code: 'invalid_upstream_response', cause: error });
    }
}

export async function openAiAdapter(profile, request, { fetchImpl = fetch, maxBytes = 50 * 1024 * 1024, signal, diagnostics, scope, profileName = request.profile } = {}) {
    const format = String(request.outputFormat ?? profile.defaults?.outputFormat ?? 'png').replace(/^image\//, '');
    const body = {
        ...(profile.body ?? {}),
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: request.size ?? openAiSize(request.width, request.height, request.model),
        quality: request.quality,
        background: request.background,
        output_format: format,
    };
    for (const key of Object.keys(body)) if (body[key] === undefined || body[key] === '') delete body[key];
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(profile.headers ?? {}) };
    if (profile.apiKey) headers.authorization ??= `Bearer ${profile.apiKey}`;
    const activity = { diagnostics, scope, profile: profileName };
    const response = await checkedFetch(profile.url, { method: 'POST', headers, body: JSON.stringify(body), signal }, profile, fetchImpl, activity);
    const json = await responseJson(response, maxBytes, 'OpenAI');
    if (json?.error) throw new PluginError('OpenAI returned an error', { code: 'upstream_error' });
    const first = json?.data?.[0];
    if (first?.b64_json) {
        const data = Buffer.from(first.b64_json, 'base64');
        if (data.length > maxBytes) throw new PluginError('Upstream image exceeds configured size limit', { code: 'response_too_large' });
        return { data, mime: sniffMime(data, `image/${format === 'jpg' ? 'jpeg' : format}`) };
    }
    if (first?.url) {
        let imageUrl;
        try {
            imageUrl = new URL(first.url);
            if (!['http:', 'https:'].includes(imageUrl.protocol)) throw new Error('unsupported protocol');
        } catch {
            throw new PluginError('OpenAI returned an invalid image URL', { code: 'invalid_upstream_response' });
        }
        const imageResponse = await checkedFetch(imageUrl, { method: 'GET', headers: { accept: 'image/*' }, signal }, profile, fetchImpl, activity);
        const data = await responseBuffer(imageResponse, maxBytes);
        return { data, mime: sniffMime(data, imageResponse.headers.get('content-type')) };
    }
    throw new PluginError('OpenAI response contained no image', { code: 'invalid_upstream_response' });
}

function interactionImage(json) {
    const steps = Array.isArray(json?.steps) ? json.steps : [];
    for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex--) {
        const content = Array.isArray(steps[stepIndex]?.content) ? steps[stepIndex].content : [];
        for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex--) {
            const item = content[contentIndex];
            if (typeof item?.data === 'string' && /^image\//i.test(String(item.mime_type ?? item.mimeType ?? ''))) {
                return { data: item.data, mime: item.mime_type ?? item.mimeType };
            }
        }
    }
    if (typeof json?.output_image?.data === 'string') return { data: json.output_image.data, mime: json.output_image.mime_type ?? 'image/png' };
    return null;
}

function geminiInteractionsUrl(profileUrl) {
    const url = new URL(profileUrl);
    if (/\/v1beta\/interactions$/i.test(url.pathname)) return url;
    let pathname = url.pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/v1beta\/models\/[^/]+:(?:stream)?generateContent$/i, '');
    url.pathname = `${pathname}/v1beta/interactions`.replace(/\/{2,}/g, '/');
    url.search = '';
    return url;
}

async function geminiInteractionsAdapter(profile, request, options = {}) {
    const { fetchImpl = fetch, maxBytes = 50 * 1024 * 1024, signal, diagnostics, scope, profileName = request.profile } = options;
    const url = geminiInteractionsUrl(profile.url);
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(profile.headers ?? {}) };
    if (profile.apiKey) {
        if (profile.queryApiKey === true || (profile.queryApiKey === undefined && /(^|\.)generativelanguage\.googleapis\.com$/i.test(url.hostname))) url.searchParams.set('key', profile.apiKey);
        else if (profile.queryApiKey === false) headers['x-goog-api-key'] ??= profile.apiKey;
        else headers.authorization ??= `Bearer ${profile.apiKey}`;
    }
    let prompt = `Create exactly one image. ${request.prompt}`;
    if (request.negative) prompt += `\nAvoid: ${request.negative}`;
    const imageFormat = {
        type: 'image',
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        ...(request.imageSize ? { image_size: request.imageSize } : {}),
    };
    const body = {
        model: request.model,
        input: [{ type: 'text', text: prompt }],
        response_format: imageFormat,
    };
    const response = await checkedFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, profile, fetchImpl, { diagnostics, scope, profile: profileName });
    const json = await responseJson(response, maxBytes, 'Gemini Interactions');
    const image = interactionImage(json);
    if (!image) {
        const rejected = String(json?.status ?? '').toLowerCase() === 'failed' || JSON.stringify(json?.steps ?? []).match(/safety|blocked|policy/i);
        throw new PluginError(rejected ? 'Gemini rejected the prompt' : 'Gemini Interactions response contained no image', { status: rejected ? 400 : 502, code: rejected ? 'safety' : 'invalid_upstream_response' });
    }
    const data = Buffer.from(image.data, 'base64');
    if (data.length > maxBytes) throw new PluginError('Upstream image exceeds configured size limit', { code: 'response_too_large' });
    return { data, mime: sniffMime(data, image.mime) };
}

function parseSse(text) {
    const events = [];
    let dataLines = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        if (line === '') {
            if (dataLines.length) events.push(dataLines.join('\n'));
            dataLines = [];
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
    }
    if (dataLines.length) events.push(dataLines.join('\n'));
    return events;
}

export async function geminiSseAdapter(profile, request, options = {}) {
    if (/^gemini-3(?:\.|-|$)/i.test(String(request.model ?? '')) || /\/v1beta\/interactions$/i.test(new URL(profile.url).pathname)) {
        return geminiInteractionsAdapter(profile, request, options);
    }
    const { fetchImpl = fetch, maxBytes = 50 * 1024 * 1024, signal, diagnostics, scope, profileName = request.profile } = options;
    const url = new URL(profile.url);
    if (!/:streamGenerateContent$/i.test(url.pathname)) {
        if (!request.model) throw new PluginError('Gemini model is required when using a base URL', { status: 400, code: 'invalid_request' });
        let basePath = url.pathname.replace(/\/+$/, '');
        basePath = /\/v1beta$/i.test(basePath) ? basePath : `${basePath}/v1beta`;
        url.pathname = `${basePath}/models/${encodeURIComponent(request.model)}:streamGenerateContent`.replace(/\/{2,}/g, '/');
    }
    url.searchParams.set('alt', 'sse');
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...(profile.headers ?? {}) };
    if (profile.apiKey) {
        if (profile.queryApiKey === true || (profile.queryApiKey === undefined && /(^|\.)generativelanguage\.googleapis\.com$/i.test(url.hostname))) {
            url.searchParams.set('key', profile.apiKey);
        } else if (profile.queryApiKey === false) {
            headers['x-goog-api-key'] ??= profile.apiKey;
        } else {
            headers.authorization ??= `Bearer ${profile.apiKey}`;
        }
    }
    let prompt = request.prompt;
    if (request.width || request.height) prompt = `Generate an image at ${request.width}x${request.height}: ${prompt}`;
    if (request.negative) prompt += `\n\nAvoid: ${request.negative}`;
    const imageConfig = {
        ...(profile.imageConfig ?? {}),
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
        ...(request.imageSize ? { imageSize: request.imageSize } : {}),
    };
    delete imageConfig.personGeneration;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            ...(profile.generationConfig ?? {}),
            ...(request.temperature !== null && request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
        },
    };
    if (profile.systemInstruction) body.systemInstruction = { parts: [{ text: profile.systemInstruction }] };
    const response = await checkedFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, profile, fetchImpl, { diagnostics, scope, profile: profileName });
    const raw = (await responseBuffer(response, maxBytes)).toString('utf8');
    for (const event of parseSse(raw)) {
        if (event === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(event); } catch { continue; }
        if (chunk?.error) {
            const status = Number(chunk.error.code) === 400 ? 400 : 502;
            const code = status === 400 || /safety|policy|blocked|filter|bad object/i.test(String(chunk.error.message ?? '')) ? 'safety' : 'upstream_error';
            throw new PluginError(code === 'safety' ? 'Gemini rejected the prompt' : 'Gemini returned an error', { status, code });
        }
        for (const candidate of chunk?.candidates ?? []) {
            for (const part of candidate?.content?.parts ?? []) {
                const inline = part.inlineData ?? part.inline_data;
                if (inline?.data) {
                    const data = Buffer.from(inline.data, 'base64');
                    if (data.length > maxBytes) throw new PluginError('Upstream image exceeds configured size limit', { code: 'response_too_large' });
                    return { data, mime: sniffMime(data, inline.mimeType ?? inline.mime_type) };
                }
            }
            const finishReason = String(candidate?.finishReason ?? '');
            if (/SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(finishReason)) {
                throw new PluginError('Gemini rejected the prompt', { status: 400, code: 'safety' });
            }
            if (/NO_IMAGE|IMAGE_OTHER/i.test(finishReason)) {
                throw new PluginError('Gemini returned no image', { status: 502, code: 'invalid_upstream_response' });
            }
        }
    }
    throw new PluginError('Gemini returned no image; verify that the selected upstream model supports image output', { code: 'invalid_upstream_response' });
}

function comfyUrl(base, endpoint) {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
    url.search = '';
    url.hash = '';
    return url;
}

function comfyImage(history, promptId, outputNode) {
    const record = history?.[promptId] ?? (history?.outputs ? history : null);
    const outputs = record?.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
    const nodeIds = outputNode ? [String(outputNode)] : Object.keys(outputs);
    for (const nodeId of nodeIds) {
        const images = outputs?.[nodeId]?.images;
        if (!Array.isArray(images)) continue;
        for (const image of images) {
            if (image && typeof image === 'object' && typeof image.filename === 'string' && image.filename) return image;
        }
    }
    return null;
}

function abortableDelay(milliseconds, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, milliseconds));
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, milliseconds);
        function done() {
            signal.removeEventListener('abort', aborted);
            resolve();
        }
        function aborted() {
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }
        signal.addEventListener('abort', aborted, { once: true });
    });
}

export async function comfyUiAdapter(profile, request, { fetchImpl = fetch, maxBytes = 50 * 1024 * 1024, signal, diagnostics, scope, profileName = request.profile } = {}) {
    const timeoutMs = Number(profile.timeoutMs ?? 180000);
    const operationSignal = combineSignal(timeoutMs, signal);
    const activity = { diagnostics, scope, profile: profileName };
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(profile.headers ?? {}) };
    const workflow = applyComfyBindings(profile, request);
    const promptResponse = await checkedFetch(comfyUrl(profile.url, 'prompt'), {
        method: 'POST', headers, body: JSON.stringify({ prompt: workflow }), signal: operationSignal,
    }, profile, fetchImpl, activity);
    const promptJson = await responseJson(promptResponse, Math.min(maxBytes, 8 * 1024 * 1024), 'ComfyUI prompt');
    const promptId = promptJson?.prompt_id;
    if (typeof promptId !== 'string' && typeof promptId !== 'number') {
        throw new PluginError('ComfyUI response contained no prompt_id', { code: 'invalid_upstream_response' });
    }
    const promptKey = String(promptId);
    const pollIntervalMs = Number(profile.pollIntervalMs ?? 500);
    let selected;
    while (!selected) {
        let historyResponse;
        try {
            historyResponse = await checkedFetch(comfyUrl(profile.url, `history/${encodeURIComponent(promptKey)}`), {
                method: 'GET', headers: { accept: 'application/json', ...(profile.headers ?? {}) }, signal: operationSignal,
            }, profile, fetchImpl, activity);
        } catch (error) {
            if (error instanceof PluginError && error.status === 400) throw new PluginError('ComfyUI rejected the history request', { status: 502, code: 'upstream_error', cause: error });
            throw error;
        }
        const history = await responseJson(historyResponse, Math.min(maxBytes, 16 * 1024 * 1024), 'ComfyUI history');
        selected = comfyImage(history, promptKey, profile.outputNode);
        const record = history?.[promptKey] ?? (history?.outputs ? history : null);
        if (!selected && record) {
            const messages = record?.status?.messages ?? record?.status_messages ?? [];
            if (record?.status?.status_str === 'error' || /execution_error|error/i.test(JSON.stringify(messages))) {
                throw new PluginError('ComfyUI workflow execution failed', { code: 'upstream_error' });
            }
            if (record?.outputs && typeof record.outputs === 'object') {
                const label = profile.outputNode ? ` at output node ${profile.outputNode}` : '';
                throw new PluginError(`ComfyUI workflow completed without an image${label}`, { code: 'invalid_upstream_response' });
            }
        }
        if (!selected) {
            try { await abortableDelay(pollIntervalMs, operationSignal); }
            catch (error) { throw new PluginError('Upstream image request timed out', { status: 504, code: 'timeout', cause: error }); }
        }
    }
    const viewUrl = comfyUrl(profile.url, 'view');
    viewUrl.searchParams.set('filename', selected.filename);
    if (typeof selected.subfolder === 'string' && selected.subfolder) viewUrl.searchParams.set('subfolder', selected.subfolder);
    if (typeof selected.type === 'string' && selected.type) viewUrl.searchParams.set('type', selected.type);
    const imageResponse = await checkedFetch(viewUrl, {
        method: 'GET', headers: { accept: 'image/*', ...(profile.headers ?? {}) }, signal: operationSignal,
    }, profile, fetchImpl, activity);
    const data = await responseBuffer(imageResponse, maxBytes);
    return { data, mime: sniffMime(data, imageResponse.headers.get('content-type')) };
}

export async function genericAdapter(profile, request, { fetchImpl = fetch, maxBytes = 50 * 1024 * 1024, signal, diagnostics, scope, profileName = request.profile } = {}) {
    const method = String(profile.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new PluginError(`Generic profile method must be GET or POST`, { status: 500, code: 'config_error' });
    const renderedUrl = renderTemplate(profile.url, request, { encodePrompt: true });
    const url = new URL(renderedUrl);
    for (const [key, value] of Object.entries(renderTemplate(profile.query ?? {}, request))) {
        url.searchParams.set(key, String(value));
    }
    const headers = { accept: profile.responseImagePath ? 'application/json' : 'image/*', ...renderTemplate(profile.headers ?? {}, request) };
    const options = { method, headers, signal };
    if (method === 'POST') {
        headers['content-type'] ??= 'application/json';
        options.body = JSON.stringify(renderTemplate(profile.body ?? {}, request));
    }
    const activity = { diagnostics, scope, profile: profileName };
    const response = await checkedFetch(url, options, profile, fetchImpl, activity);
    if (!profile.responseImagePath) {
        const data = await responseBuffer(response, maxBytes);
        return { data, mime: sniffMime(data, response.headers.get('content-type')) };
    }
    const json = await responseJson(response, maxBytes, 'Generic upstream');
    const value = getJsonPath(json, profile.responseImagePath);
    const decoded = decodeImage(value, profile.responseEncoding ?? 'base64');
    if (typeof decoded === 'string') {
        const imageResponse = await checkedFetch(decoded, { method: 'GET', headers: { accept: 'image/*' }, signal }, profile, fetchImpl, activity);
        const data = await responseBuffer(imageResponse, maxBytes);
        return { data, mime: sniffMime(data, imageResponse.headers.get('content-type')) };
    }
    if (decoded.length > maxBytes) throw new PluginError('Upstream image exceeds configured size limit', { code: 'response_too_large' });
    const mimeHint = profile.responseMimePath ? getJsonPath(json, profile.responseMimePath) : response.headers.get('content-type');
    return { data: decoded, mime: sniffMime(decoded, mimeHint) };
}

export function normalizeRequest(input, config) {
    if (input?.id !== undefined) throw new PluginError('The id parameter is not supported; use seed for deterministic generation', { status: 400, code: 'invalid_request' });
    const profileName = String(input?.profile ?? input?.backend ?? config.defaultProfile ?? '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(profileName)) throw new PluginError('Invalid profile name', { status: 400, code: 'invalid_profile' });
    const profile = config.profiles?.[profileName];
    if (!profile) throw new PluginError(`Unknown profile: ${profileName || '(none)'}`, { status: 400, code: 'invalid_profile' });
    const prompt = String(input?.prompt ?? '').trim();
    if (!prompt) throw new PluginError('prompt is required', { status: 400, code: 'invalid_request' });
    if (prompt.length > Number(config.limits?.maxPromptLength ?? 12000)) throw new PluginError('prompt is too long', { status: 400, code: 'invalid_request' });
    const defaults = profile.defaults ?? {};
    const maxDimension = Number(config.limits?.maxDimension ?? 4096);
    const integer = (value, fallback, label) => {
        const parsed = value === undefined || value === '' ? Number(fallback) : Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxDimension) throw new PluginError(`${label} must be an integer from 1 to ${maxDimension}`, { status: 400, code: 'invalid_request' });
        return parsed;
    };
    let seed;
    if (input.seed !== undefined && input.seed !== null && input.seed !== '') {
        seed = Number(input.seed);
        if (!Number.isSafeInteger(seed) || seed < 0) throw new PluginError('seed must be a non-negative safe integer', { status: 400, code: 'invalid_request' });
    }
    const requestedModel = input.model === undefined || input.model === '' ? (profile.model ?? defaults.model ?? '') : String(input.model);
    if (input.model !== undefined && input.model !== '' && (!Array.isArray(profile.allowedModels) || profile.allowedModels.length === 0)) {
        throw new PluginError('This profile does not allow selecting a model', { status: 400, code: 'invalid_request' });
    }
    if (Array.isArray(profile.allowedModels) && profile.allowedModels.length > 0 && !profile.allowedModels.includes(requestedModel)) {
        throw new PluginError('Requested model is not allowed by this profile', { status: 400, code: 'invalid_request' });
    }
    const allowedRatios = new Set(['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
    const aspectRatio = String(input.aspectRatio ?? input.aspect_ratio ?? defaults.aspectRatio ?? '').toLowerCase();
    if (aspectRatio && !allowedRatios.has(aspectRatio)) throw new PluginError('aspect_ratio is not supported', { status: 400, code: 'invalid_request' });
    const imageSize = String(input.imageSize ?? input.image_size ?? defaults.imageSize ?? '').toUpperCase();
    if (imageSize && !['512', '1K', '2K', '4K'].includes(imageSize)) throw new PluginError('image_size must be 512, 1K, 2K, or 4K', { status: 400, code: 'invalid_request' });
    let temperature = input.temperature ?? defaults.temperature;
    temperature = temperature === undefined || temperature === '' ? null : Number(temperature);
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new PluginError('temperature must be from 0 to 2', { status: 400, code: 'invalid_request' });
    const personGeneration = String(input.personGeneration ?? input.person_generation ?? defaults.personGeneration ?? '').toUpperCase();
    if (personGeneration && !['ALLOW_ALL', 'ALLOW_ADULT', 'ALLOW_NONE'].includes(personGeneration)) throw new PluginError('person_generation is invalid', { status: 400, code: 'invalid_request' });
    let width = integer(input.width, defaults.width ?? 1024, 'width');
    let height = integer(input.height, defaults.height ?? 1024, 'height');
    if (aspectRatio && input.width === undefined && input.height === undefined) {
        const [rw, rh] = aspectRatio.split(':').map(Number);
        const target = imageSize === '4K' ? 4096 : imageSize === '2K' ? 2048 : imageSize === '512' ? 512 : 1024;
        if (rw >= rh) {
            width = Math.min(maxDimension, target);
            height = Math.max(1, Math.round(width * rh / rw));
        } else {
            height = Math.min(maxDimension, target);
            width = Math.max(1, Math.round(height * rw / rh));
        }
    }
    const request = {
        profile: profileName,
        prompt,
        width,
        height,
        seed: seed ?? null,
        negative: String(input.negative ?? defaults.negative ?? ''),
        model: String(requestedModel),
        quality: String(input.quality ?? defaults.quality ?? ''),
        outputFormat: String(input.outputFormat ?? input.output_format ?? defaults.outputFormat ?? ''),
        background: String(input.background ?? defaults.background ?? ''),
        enhance: input.enhance === undefined ? Boolean(defaults.enhance) : ['true', '1', true, 1].includes(input.enhance),
        aspectRatio,
        imageSize,
        temperature,
        personGeneration,
    };
    return { profile, request };
}

export function profilePublicView(name, profile, isDefault = false) {
    return {
        name,
        default: isDefault,
        type: profile.type,
        model: profile.model ?? profile.defaults?.model ?? null,
        defaults: profile.defaults ?? {},
    };
}

export function validateConfig(config) {
    if (!config || typeof config !== 'object') throw new PluginError('Configuration root must be an object', { status: 500, code: 'config_error' });
    if (config.outputs !== undefined) {
        if (!config.outputs || typeof config.outputs !== 'object' || Array.isArray(config.outputs)) throw new PluginError('outputs must be an object', { status: 500, code: 'config_error' });
        if (config.outputs.directory !== undefined && (typeof config.outputs.directory !== 'string' || !config.outputs.directory.trim())) throw new PluginError('outputs.directory must be a non-empty string', { status: 500, code: 'config_error' });
        if (config.outputs.enabled !== undefined && typeof config.outputs.enabled !== 'boolean') throw new PluginError('outputs.enabled must be boolean', { status: 500, code: 'config_error' });
        if (config.outputs.includePrompt !== undefined && typeof config.outputs.includePrompt !== 'boolean') throw new PluginError('outputs.includePrompt must be boolean', { status: 500, code: 'config_error' });
    }
    if (!config.profiles || typeof config.profiles !== 'object' || !Object.keys(config.profiles).length) throw new PluginError('At least one profile is required', { status: 500, code: 'config_error' });
    if (!config.defaultProfile) config.defaultProfile = Object.keys(config.profiles)[0];
    if (!config.profiles[config.defaultProfile]) throw new PluginError(`Default profile does not exist: ${config.defaultProfile}`, { status: 500, code: 'config_error' });
    for (const [name, profile] of Object.entries(config.profiles)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new PluginError(`Invalid profile name: ${name}`, { status: 500, code: 'config_error' });
        if (!['openai', 'gemini-sse', 'generic', 'comfyui'].includes(profile.type)) throw new PluginError(`Invalid type for profile ${name}`, { status: 500, code: 'config_error' });
        if (profile.instructionPrompt !== undefined && (typeof profile.instructionPrompt !== 'string' || profile.instructionPrompt.length > INSTRUCTION_PROMPT_MAX_LENGTH)) {
            throw new PluginError(`Profile ${name} instructionPrompt must be a string no longer than ${INSTRUCTION_PROMPT_MAX_LENGTH} characters`, { status: 500, code: 'config_error' });
        }
        try {
            const url = new URL(profile.url);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
        } catch {
            throw new PluginError(`Invalid URL for profile ${name}`, { status: 500, code: 'config_error' });
        }
        if (profile.type === 'comfyui') {
            const invalid = message => new PluginError(message, { status: 500, code: 'config_error' });
            profile.workflow = validateComfyWorkflow(profile.workflow, `Profile ${name} workflow`, invalid);
            profile.bindings = validateComfyBindings(profile.bindings, profile.workflow, `Profile ${name} bindings`, invalid);
            if (profile.outputNode !== undefined && !Object.hasOwn(profile.workflow, String(profile.outputNode))) throw invalid(`Profile ${name} outputNode does not exist in workflow`);
            if (profile.pollIntervalMs !== undefined && (!Number.isSafeInteger(profile.pollIntervalMs) || profile.pollIntervalMs < 50 || profile.pollIntervalMs > 60_000)) throw invalid(`Profile ${name} pollIntervalMs must be an integer from 50 to 60000`);
        }
    }
    return config;
}

export class DiskCache {
    constructor({ directory, enabled = true, ttlSeconds = null }) {
        this.directory = directory;
        this.enabled = Boolean(enabled);
        this.ttlSeconds = ttlSeconds === null || ttlSeconds === undefined ? null : Number(ttlSeconds);
        if (this.ttlSeconds !== null && (!Number.isFinite(this.ttlSeconds) || this.ttlSeconds < 0)) {
            throw new PluginError('cache.ttlSeconds must be null or a non-negative number', { status: 500, code: 'config_error' });
        }
    }

    async init() {
        if (this.enabled) await mkdir(this.directory, { recursive: true });
    }

    paths(key) {
        return { data: path.join(this.directory, `${key}.bin`), meta: path.join(this.directory, `${key}.json`) };
    }

    async get(key) {
        if (!this.enabled) return null;
        const files = this.paths(key);
        try {
            const [data, rawMeta] = await Promise.all([readFile(files.data), readFile(files.meta, 'utf8')]);
            const meta = JSON.parse(rawMeta);
            if (this.ttlSeconds !== null && Date.now() - meta.createdAt > this.ttlSeconds * 1000) {
                await Promise.allSettled([rm(files.data, { force: true }), rm(files.meta, { force: true })]);
                return null;
            }
            const etag = createHash('sha256').update(data).digest('hex');
            if (etag !== meta.etag) {
                await Promise.allSettled([rm(files.data, { force: true }), rm(files.meta, { force: true })]);
                return null;
            }
            return { data, mime: sniffMime(data, meta.mime), etag, createdAt: meta.createdAt, cached: true };
        } catch (error) {
            if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async set(key, result) {
        const data = Buffer.from(result.data);
        const etag = createHash('sha256').update(data).digest('hex');
        const entry = { data, mime: sniffMime(data, result.mime), etag, createdAt: Date.now(), cached: false };
        if (!this.enabled) return entry;
        await this.init();
        const files = this.paths(key);
        const suffix = `${process.pid}-${Math.random().toString(16).slice(2)}`;
        const dataTemp = `${files.data}.${suffix}.tmp`;
        const metaTemp = `${files.meta}.${suffix}.tmp`;
        await writeFile(dataTemp, data);
        await writeFile(metaTemp, JSON.stringify({ mime: entry.mime, etag, createdAt: entry.createdAt }));
        await rename(dataTemp, files.data);
        await rename(metaTemp, files.meta);
        return entry;
    }

    async delete(key) {
        if (!this.enabled) return { removed: 0 };
        const files = this.paths(key);
        const existed = await Promise.all([files.data, files.meta].map(async file => {
            try { await stat(file); return true; } catch { return false; }
        }));
        await Promise.allSettled([rm(files.data, { force: true }), rm(files.meta, { force: true })]);
        return { removed: existed.filter(Boolean).length };
    }

    async clear() {
        if (!this.enabled) return { removed: 0 };
        await this.init();
        const names = await readdir(this.directory);
        const cacheFiles = names.filter(name => /^[a-f0-9]{64}\.(?:bin|json)$/.test(name));
        await Promise.all(cacheFiles.map(name => rm(path.join(this.directory, name), { force: true })));
        return { removed: cacheFiles.length };
    }

    async stats() {
        if (!this.enabled) return { enabled: false, entries: 0, bytes: 0, directory: this.directory };
        await this.init();
        const names = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.bin$/.test(name));
        let bytes = 0;
        for (const name of names) bytes += (await stat(path.join(this.directory, name))).size;
        return { enabled: true, entries: names.length, bytes, ttlSeconds: this.ttlSeconds, directory: this.directory };
    }
}

const MIME_EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
});

function outputExtension(mime) {
    const extension = MIME_EXTENSIONS[mime];
    if (!extension) throw new PluginError(`Unsupported output MIME type: ${mime}`, { status: 500, code: 'invalid_upstream_response' });
    return extension;
}

function publicOutputParams(request) {
    const { prompt: _prompt, ...params } = request;
    return params;
}

async function atomicCreate(file, data) {
    const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
    try {
        await writeFile(temp, data, { flag: 'wx' });
        try {
            // A hard-link publish is atomic and never overwrites an entry won by
            // another process. The temp file is then removed in either case.
            await link(temp, file);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    } finally {
        await rm(temp, { force: true }).catch(() => {});
    }
}

/**
 * Durable, authoritative generated outputs. Entries deliberately have no TTL:
 * browser caches and the internal DiskCache may be cleared without discarding
 * the canonical server bytes for a normalized generation key.
 */
export class OutputStore {
    constructor({ directory, enabled = true, includePrompt = false } = {}) {
        if (!directory) throw new PluginError('outputs.directory is required', { status: 500, code: 'config_error' });
        this.directory = directory;
        this.enabled = Boolean(enabled);
        this.includePrompt = Boolean(includePrompt);
    }

    async init() {
        if (this.enabled) await mkdir(this.directory, { recursive: true });
    }

    metadataPath(key) {
        if (!/^[a-f0-9]{64}$/.test(String(key))) throw new PluginError('Invalid output key', { status: 400, code: 'invalid_request' });
        return path.join(this.directory, `${key}.json`);
    }

    imagePath(key, mime) {
        if (!/^[a-f0-9]{64}$/.test(String(key))) throw new PluginError('Invalid output key', { status: 400, code: 'invalid_request' });
        return path.join(this.directory, `${key}.${outputExtension(mime)}`);
    }

    async get(key) {
        if (!this.enabled) return null;
        this.metadataPath(key);
        try {
            const metadata = JSON.parse(await readFile(this.metadataPath(key), 'utf8'));
            if (metadata.key !== key || typeof metadata.mime !== 'string') return null;
            const image = this.imagePath(key, metadata.mime);
            const data = await readFile(image);
            const mime = sniffMime(data, metadata.mime);
            const etag = createHash('sha256').update(data).digest('hex');
            if (metadata.etag && metadata.etag !== etag) return null;
            return { data, mime, etag, createdAt: metadata.createdAt, cached: true, durable: true, metadata };
        } catch (error) {
            if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async set(key, result, { request, profileFingerprint } = {}) {
        const data = Buffer.from(result.data);
        const mime = sniffMime(data, result.mime);
        const etag = createHash('sha256').update(data).digest('hex');
        if (!this.enabled) return { data, mime, etag, createdAt: Date.now(), cached: false, durable: false };
        await this.init();

        const existing = await this.get(key);
        if (existing) return existing;

        const lockPath = path.join(this.directory, `${key}.lock`);
        const image = this.imagePath(key, mime);
        let lock;
        try {
            lock = await open(lockPath, 'wx');
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            // A second process owns generation/persistence for the same key.
            // Wait briefly for its authoritative metadata to become visible.
            for (let attempt = 0; attempt < 200; attempt++) {
                const raced = await this.get(key);
                if (raced) return raced;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new PluginError('Timed out waiting for generated output persistence', { status: 503, code: 'output_busy' });
        }

        try {
            const afterLock = await this.get(key);
            if (afterLock) return afterLock;
            const createdAt = new Date().toISOString();
            const metadata = {
                key,
                createdAt,
                mime,
                etag,
                profile: request?.profile ?? null,
                seed: request?.seed ?? null,
                profileFingerprint: profileFingerprint ?? null,
                params: publicOutputParams(request ?? {}),
                promptHash: fingerprint(String(request?.prompt ?? '')),
                ...(this.includePrompt ? { prompt: String(request?.prompt ?? '') } : {}),
            };
            await atomicCreate(image, data);
            await atomicCreate(this.metadataPath(key), `${JSON.stringify(metadata, null, 2)}\n`);
        } finally {
            await lock.close().catch(() => {});
            await rm(lockPath, { force: true }).catch(() => {});
        }

        const stored = await this.get(key);
        if (!stored) {
            await Promise.allSettled([rm(image, { force: true }), rm(this.metadataPath(key), { force: true })]);
            throw new PluginError('Could not persist generated output', { status: 500, code: 'output_error' });
        }
        return { ...stored, cached: false };
    }

    async delete(key) {
        if (!this.enabled) return { removed: 0 };
        this.metadataPath(key);
        let metadata;
        try { metadata = JSON.parse(await readFile(this.metadataPath(key), 'utf8')); } catch { metadata = null; }
        const files = [this.metadataPath(key)];
        if (metadata?.mime) {
            try { files.push(this.imagePath(key, metadata.mime)); } catch { /* Invalid metadata cannot select an arbitrary path. */ }
        } else {
            for (const extension of Object.values(MIME_EXTENSIONS)) files.push(path.join(this.directory, `${key}.${extension}`));
        }
        const existed = await Promise.all(files.map(async file => {
            try { await stat(file); return true; } catch { return false; }
        }));
        await Promise.allSettled(files.map(file => rm(file, { force: true })));
        return { removed: existed.filter(Boolean).length };
    }

    async clear() {
        if (!this.enabled) return { removed: 0 };
        await this.init();
        const names = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.(?:json|png|jpg|webp|gif|avif|svg)$/.test(name));
        await Promise.all(names.map(name => rm(path.join(this.directory, name), { force: true })));
        return { removed: names.length };
    }

    async stats() {
        if (!this.enabled) return { enabled: false, entries: 0, bytes: 0, directory: this.directory };
        await this.init();
        const names = await readdir(this.directory);
        const images = names.filter(name => /^[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif|svg)$/.test(name));
        let bytes = 0;
        for (const name of images) bytes += (await stat(path.join(this.directory, name))).size;
        return { enabled: true, entries: images.length, bytes, directory: this.directory, includePrompt: this.includePrompt };
    }
}

export class ImageService {
    constructor(config, { cache, outputs = null, fetchImpl = fetch, diagnostics = null, scope = 'anonymous' } = {}) {
        this.config = validateConfig(config);
        this.cache = cache;
        this.outputs = outputs;
        this.fetchImpl = fetchImpl;
        this.diagnostics = diagnostics;
        this.scope = scope;
        this.inflight = new Map();
    }

    setConfig(config) {
        this.config = validateConfig(config);
    }

    prepare(input) {
        const normalized = normalizeRequest(input, this.config);
        const cacheProfile = structuredClone(normalized.profile);
        delete cacheProfile.apiKey;
        // Editor-only instructions are returned to clients but never affect
        // generation requests or their cache identity.
        delete cacheProfile.instructionPrompt;
        if (cacheProfile.headers && typeof cacheProfile.headers === 'object') {
            for (const key of Object.keys(cacheProfile.headers)) {
                if (/authorization|api[-_]?key|token|secret/i.test(key)) delete cacheProfile.headers[key];
            }
        }
        const profileFingerprint = fingerprint(cacheProfile);
        const key = fingerprint({ version: 3, request: normalized.request, profileFingerprint });
        return { ...normalized, key, profileFingerprint };
    }

    async generate(input, { bypassCache = false, signal, action = 'generate' } = {}) {
        const startedAt = Date.now();
        let prepared;
        try {
            prepared = this.prepare(input);
        } catch (error) {
            this.#record({ level: 'error', event: 'generation.complete', action, status: error?.status ?? 500, code: error?.code ?? 'internal_error', durationMs: Date.now() - startedAt });
            throw error;
        }
        const detail = { action, profile: prepared.request.profile };
        try {
            // Durable outputs are authoritative and are consulted even when the
            // internal cache is bypassed (for example after a browser _refresh).
            const durable = await this.outputs?.get(prepared.key);
            if (durable) {
                this.#record({ event: 'cache.lookup', ...detail, cache: 'hit', status: 200, bytes: durable.data.length });
                this.#record({ event: 'generation.complete', ...detail, cache: 'hit', status: 200, bytes: durable.data.length, durationMs: Date.now() - startedAt });
                return { ...durable, key: prepared.key, request: prepared.request };
            }
            if (!bypassCache) {
                const hit = await this.cache?.get(prepared.key);
                if (hit) {
                    // Seamlessly promote legacy DiskCache entries into durable
                    // outputs, so existing images survive new devices without
                    // forcing one more provider generation.
                    const promoted = this.outputs
                        ? await this.outputs.set(prepared.key, hit, {
                            request: prepared.request,
                            profileFingerprint: prepared.profileFingerprint,
                        })
                        : hit;
                    this.#record({ event: 'cache.lookup', ...detail, cache: 'hit', status: 200, bytes: promoted.data.length });
                    this.#record({ event: 'generation.complete', ...detail, cache: 'hit', status: 200, bytes: promoted.data.length, durationMs: Date.now() - startedAt });
                    return { ...promoted, key: prepared.key, request: prepared.request };
                }
                this.#record({ event: 'cache.lookup', ...detail, cache: 'miss' });
            } else {
                this.#record({ event: 'cache.lookup', ...detail, cache: 'bypass' });
            }
            if (this.inflight.has(prepared.key)) {
                const result = await this.inflight.get(prepared.key);
                this.#record({ event: 'generation.complete', ...detail, cache: bypassCache ? 'bypass' : 'miss', status: 200, bytes: result.data.length, durationMs: Date.now() - startedAt });
                return result;
            }
            const maxConcurrent = Number(this.config.limits?.maxConcurrentRequests ?? 4);
            if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new PluginError('limits.maxConcurrentRequests must be a positive integer', { status: 500, code: 'config_error' });
            if (this.inflight.size >= maxConcurrent) throw new PluginError('Too many image requests are already running', { status: 429, code: 'rate_limit' });
            const operation = this.#generateOwned(prepared, signal).finally(() => this.inflight.delete(prepared.key));
            this.inflight.set(prepared.key, operation);
            const result = await operation;
            this.#record({ event: 'generation.complete', ...detail, cache: bypassCache ? 'bypass' : 'miss', status: 200, bytes: result.data.length, durationMs: Date.now() - startedAt });
            return result;
        } catch (error) {
            this.#record({ level: 'error', event: 'generation.complete', ...detail, cache: bypassCache ? 'bypass' : 'error', status: error?.status ?? 500, code: error?.code ?? 'internal_error', durationMs: Date.now() - startedAt });
            throw error;
        }
    }

    async #generateOwned(prepared, signal) {
        const options = {
            fetchImpl: this.fetchImpl,
            maxBytes: Number(this.config.limits?.maxResponseBytes ?? 50 * 1024 * 1024),
            signal,
            diagnostics: this.diagnostics,
            scope: this.scope,
            profileName: prepared.request.profile,
        };
        let result;
        switch (prepared.profile.type) {
            case 'openai': result = await openAiAdapter(prepared.profile, prepared.request, options); break;
            case 'gemini-sse': result = await geminiSseAdapter(prepared.profile, prepared.request, options); break;
            case 'generic': result = await genericAdapter(prepared.profile, prepared.request, options); break;
            case 'comfyui': result = await comfyUiAdapter(prepared.profile, prepared.request, options); break;
            default: throw new PluginError('Unsupported profile type', { status: 500, code: 'config_error' });
        }
        const durable = this.outputs
            ? await this.outputs.set(prepared.key, result, {
                request: prepared.request,
                profileFingerprint: prepared.profileFingerprint,
            })
            : { ...result, etag: createHash('sha256').update(result.data).digest('hex'), cached: false };
        // Internal cache is only an accelerator. Failure to populate it must not
        // invalidate a successfully persisted authoritative output.
        if (this.cache) await this.cache.set(prepared.key, durable).catch(() => {});
        return { ...durable, key: prepared.key, request: prepared.request };
    }

    #record(event) {
        recordDiagnostic(this.diagnostics, { scope: this.scope, ...event });
    }
}
