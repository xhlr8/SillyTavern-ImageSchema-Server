import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { DiskCache, ImageService, OutputStore, PluginError, expandEnv, sniffMime, validateConfig } from './core.mjs';
import { ActivityDiagnostics, diagnosticsContract, diagnosticsScope, isDiagnosticsAdmin, recordDiagnostic } from './diagnostics.mjs';
import { ManagedProfileStore, profilesPublicView, validateManagedProfile, validateProfileName } from './managed-config.mjs';
import { analyzeComfyWorkflow, validateComfyWorkflow } from './comfyui.mjs';

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
let state = null;

export const info = Object.freeze({
    id: 'image-schema',
    name: 'Image Schema Server',
    description: 'Named image generation profiles with secure server-side credentials and persistent caching.',
});

async function loadConfig() {
    const configuredPath = process.env.SILLYTAVERN_IMAGE_CONFIG || path.join(pluginDirectory, 'config.yaml');
    const configPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(pluginDirectory, configuredPath);
    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new PluginError(`Image server config not found at ${configPath}; copy config.example.yaml to config.yaml`, { status: 500, code: 'config_error' });
        }
        throw error;
    }
    let parsed;
    try { parsed = YAML.parse(raw); } catch (error) {
        throw new PluginError(`Could not parse image server config: ${error.message}`, { status: 500, code: 'config_error', cause: error });
    }
    return { config: validateConfig(expandEnv(parsed)), configPath };
}

function asyncRoute(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
}

function generationInput(request, includePathPrompt = false) {
    const outer = request.method === 'GET' ? request.query : (request.body ?? {});
    const nested = outer.request && typeof outer.request === 'object' ? outer.request : null;
    const source = nested
        ? { ...nested, ...(nested.params && typeof nested.params === 'object' ? nested.params : {}), prompt: nested.text ?? nested.prompt }
        : outer;
    let prompt = includePathPrompt ? request.params.prompt : source.prompt;
    if (includePathPrompt && typeof prompt === 'string') {
        try { prompt = decodeURIComponent(prompt); } catch { /* Express may already have decoded the path. */ }
    }
    return {
        prompt,
        profile: source.profile ?? source.backend ?? source.b,
        width: source.width ?? source.w,
        height: source.height ?? source.h,
        seed: source.seed,
        negative: source.negative ?? source.neg,
        model: source.model,
        quality: source.quality,
        outputFormat: source.outputFormat ?? source.output_format ?? source.f,
        background: source.background,
        enhance: source.enhance,
        aspectRatio: source.aspectRatio ?? source.aspect_ratio ?? source.ar,
        imageSize: source.imageSize ?? source.image_size ?? source.s,
        temperature: source.temperature ?? source.t,
        personGeneration: source.personGeneration ?? source.person_generation ?? source.p,
        id: source.id,
    };
}

function etagMatches(header, etag) {
    if (!header) return false;
    return String(header).split(',').map(value => value.trim()).some(value => value === '*' || value.replace(/^W\//, '') === `"${etag}"`);
}

function sendImage(request, response, result, config, { privateCache = false } = {}) {
    const etag = result.etag ?? createHash('sha256').update(result.data).digest('hex');
    const isError = Boolean(result.error);
    const ttl = config.cache?.ttlSeconds;
    const persistent = ttl === null || ttl === undefined;
    const maxAge = persistent ? 31536000 : Math.max(0, Number(ttl));
    response.set({
        'Content-Disposition': 'inline',
        'Cache-Control': isError ? 'no-store' : (persistent
            ? `${privateCache ? 'private' : 'public'}, max-age=${maxAge}, immutable`
            : `${privateCache ? 'private' : 'public'}, max-age=${maxAge}`),
        ...(isError ? {} : { ETag: `"${etag}"` }),
        'X-Content-Type-Options': 'nosniff',
        'X-Image-Cache': isError ? 'ERROR' : (result.cached ? 'HIT' : 'MISS'),
        ...(result.effectiveProfile ? { 'X-Image-Profile': result.effectiveProfile } : {}),
        ...(result.requestedProfile ? { 'X-Image-Requested-Profile': result.requestedProfile } : {}),
        ...(result.fallbackReason ? { 'X-Image-Fallback-Reason': result.fallbackReason } : {}),
    });
    if (!isError && etagMatches(request.headers['if-none-match'], etag)) return response.status(304).end();
    response.set({
        'Content-Type': sniffMime(result.data, result.mime),
        'Content-Length': String(result.data.length),
    });
    return response.status(200).send(result.data);
}

function builtInErrorImage(error) {
    const rejected = error.status === 400 || error.code === 'safety' || error.code === 'invalid_request';
    const title = rejected ? 'Rejected Prompt' : 'Image Generation Failed';
    const subtitle = rejected ? 'The provider declined this request.' : 'Check Plugin activity for details.';
    const accent = rejected ? '#ff8fa3' : '#ffb86b';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="384" viewBox="0 0 768 384"><rect width="768" height="384" rx="24" fill="#151722"/><rect x="12" y="12" width="744" height="360" rx="18" fill="none" stroke="${accent}" stroke-width="4"/><text x="384" y="176" text-anchor="middle" fill="${accent}" font-family="system-ui,sans-serif" font-size="42" font-weight="700">${title}</text><text x="384" y="226" text-anchor="middle" fill="#d8d9e8" font-family="system-ui,sans-serif" font-size="20">${subtitle}</text></svg>`;
    const data = Buffer.from(svg, 'utf8');
    return { data, mime: 'image/svg+xml', etag: createHash('sha256').update(data).digest('hex'), cached: false, error: true, errorCode: error.code };
}

function errorImage(_config, error) {
    return builtInErrorImage(error);
}

function exactBody(request, allowed) {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PluginError('Request body must be an object', { status: 400, code: 'invalid_request' });
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new PluginError(`Unsupported request field: ${key}`, { status: 400, code: 'invalid_request' });
    }
    return body;
}

function requireAuthenticated(request, _response, next) {
    const identity = request.user?.profile?.handle ?? request.user?.id;
    if (identity === undefined || identity === null || String(identity) === '') {
        return next(new PluginError('Authentication is required', { status: 401, code: 'unauthorized' }));
    }
    return next();
}

function requireAdmin(request, _response, next) {
    const profile = request.user?.profile;
    if (profile && Object.hasOwn(profile, 'admin') && profile.admin !== true) {
        return next(new PluginError('Administrator access is required', { status: 403, code: 'forbidden' }));
    }
    return next();
}

function requireExplicitAdmin(request, _response, next) {
    if (!isDiagnosticsAdmin(request)) {
        return next(new PluginError('Administrator access is required', { status: 403, code: 'forbidden' }));
    }
    return next();
}

function contractProfile(input) {
    const source = exactObject(input, 'profile');
    const common = ['name', 'type', 'url', 'model', 'allowedModels', 'timeoutMs', 'defaults', 'instructionPrompt'];
    const byType = {
        openai: [...common, 'body'],
        'gemini-sse': [...common, 'queryApiKey', 'systemInstruction', 'generationConfig', 'imageConfig'],
        generic: [...common, 'method', 'query', 'body', 'responseImagePath', 'responseMimePath', 'responseEncoding'],
        comfyui: ['name', 'type', 'url', 'workflow', 'bindings', 'outputNode', 'pollIntervalMs', 'timeoutMs', 'instructionPrompt'],
    };
    const allowed = new Set(byType[source.type] ?? common);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new PluginError(`profile contains unsupported field: ${key}`, { status: 400, code: 'invalid_config' });
    const { name, ...profile } = source;
    return { name: validateProfileName(name), profile: validateManagedProfile(profile) };
}

function exactObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError(`${label} must be an object`, { status: 400, code: 'invalid_request' });
    return value;
}

function boundedIdentifier(value, label) {
    if (!['string', 'number'].includes(typeof value) || !String(value).trim() || String(value).length > 512) {
        throw new PluginError(`${label} must be a non-empty string or number of at most 512 characters`, { status: 400, code: 'invalid_request' });
    }
    return String(value);
}

function outputId(value, label = 'outputId') {
    const normalized = String(value ?? '');
    if (!/^[a-f0-9]{64}$/.test(normalized)) throw new PluginError(`${label} must be a 64-character output ID`, { status: 400, code: 'invalid_request' });
    return normalized;
}

function referenceIdentity(input) {
    const source = exactObject(input, 'reference');
    return {
        chatId: boundedIdentifier(source.chatId, 'chatId'),
        messageId: boundedIdentifier(source.messageId, 'messageId'),
        swipeKey: boundedIdentifier(source.swipeKey, 'swipeKey'),
        slotId: boundedIdentifier(source.slotId, 'slotId'),
    };
}

function comfyObjectInfoUrl(value) {
    if (typeof value !== 'string' || value.length > 8192) throw new PluginError('url must be an HTTP(S) URL', { status: 400, code: 'invalid_request' });
    let url;
    try {
        url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe URL');
    } catch {
        throw new PluginError('url must be an HTTP(S) URL without embedded credentials', { status: 400, code: 'invalid_request' });
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/object_info`.replace(/\/{2,}/g, '/');
    url.search = '';
    url.hash = '';
    return url;
}

async function limitedJson(response, maximum = 32 * 1024 * 1024) {
    const declared = Number(response.headers.get('content-length'));
    if (declared && declared > maximum) throw new PluginError('ComfyUI object_info response is too large', { status: 502, code: 'response_too_large' });
    const reader = response.body?.getReader?.();
    let data;
    if (!reader) {
        data = Buffer.from(await response.arrayBuffer());
        if (data.length > maximum) throw new PluginError('ComfyUI object_info response is too large', { status: 502, code: 'response_too_large' });
    } else {
        const chunks = [];
        let total = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximum) {
                await reader.cancel().catch(() => {});
                throw new PluginError('ComfyUI object_info response is too large', { status: 502, code: 'response_too_large' });
            }
            chunks.push(Buffer.from(value));
        }
        data = Buffer.concat(chunks, total);
    }
    try { return JSON.parse(data.toString('utf8')); }
    catch (error) { throw new PluginError('ComfyUI object_info response was not JSON', { status: 502, code: 'invalid_upstream_response', cause: error }); }
}

function contractConfigView(view) {
    return {
        defaultProfile: view.defaultProfile,
        routing: view.routing,
        profiles: Object.values(view.profiles).map(profile => ({
            name: profile.name,
            type: profile.type,
            url: profile.url,
            ...(profile.type === 'generic' ? {
                method: profile.method ?? 'GET',
                ...(profile.query ? { query: profile.query } : {}),
                ...(profile.body ? { body: profile.body } : {}),
                ...(profile.responseImagePath ? { responseImagePath: profile.responseImagePath } : {}),
                ...(profile.responseMimePath ? { responseMimePath: profile.responseMimePath } : {}),
                ...(profile.responseEncoding ? { responseEncoding: profile.responseEncoding } : {}),
            } : {}),
            ...(profile.type === 'comfyui' ? {
                workflow: profile.workflow,
                bindings: profile.bindings,
                ...(profile.outputNode ? { outputNode: profile.outputNode } : {}),
                pollIntervalMs: profile.pollIntervalMs ?? 500,
            } : {}),
            model: profile.model ?? '',
            allowedModels: profile.allowedModels ?? [],
            timeoutMs: profile.timeoutMs ?? 120000,
            defaults: profile.defaults ?? {},
            instructionPrompt: profile.instructionPrompt ?? '',
            apiKeyConfigured: profile.hasSecret === true,
        })),
    };
}

export async function init(router) {
    if (state) throw new PluginError('Image server plugin is already initialized', { status: 500, code: 'config_error' });
    const { config: baseConfig, configPath } = await loadConfig();
    const managedSetting = process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG || path.join(pluginDirectory, 'managed-config.json');
    const managedPath = path.isAbsolute(managedSetting) ? managedSetting : path.resolve(pluginDirectory, managedSetting);
    const cacheDirectorySetting = baseConfig.cache?.directory ?? './cache';
    const configuredCacheDirectory = path.isAbsolute(cacheDirectorySetting) ? cacheDirectorySetting : path.resolve(pluginDirectory, cacheDirectorySetting);
    const outputDirectorySetting = baseConfig.outputs?.directory ?? './outputs';
    const configuredOutputDirectory = path.isAbsolute(outputDirectorySetting) ? outputDirectorySetting : path.resolve(pluginDirectory, outputDirectorySetting);
    const caches = new Map();
    const outputs = new Map();
    const services = new Map();
    const diagnostics = new ActivityDiagnostics({ limit: Number(baseConfig.diagnostics?.limit ?? diagnosticsContract.defaultLimit) });
    let config;
    const store = new ManagedProfileStore({
        baseConfig,
        filePath: managedPath,
        onChange: nextConfig => {
            config = nextConfig;
            for (const service of services.values()) service.setConfig(nextConfig);
            if (state) state.config = nextConfig;
        },
    });
    config = await store.load();
    const getUserState = async request => {
        const scope = diagnosticsScope(request);
        if (!caches.has(scope)) {
            const cacheDirectory = config.cache?.perUser === false ? configuredCacheDirectory : path.join(configuredCacheDirectory, scope);
            // Durable outputs are always user-scoped, even when the disposable
            // accelerator cache is intentionally shared.
            const outputDirectory = path.join(configuredOutputDirectory, scope);
            const cache = new DiskCache({ directory: cacheDirectory, enabled: config.cache?.enabled !== false, ttlSeconds: config.cache?.ttlSeconds ?? null });
            const outputStore = new OutputStore({
                directory: outputDirectory,
                enabled: config.outputs?.enabled !== false,
                includePrompt: config.outputs?.includePrompt === true,
            });
            await Promise.all([cache.init(), outputStore.init()]);
            caches.set(scope, cache);
            outputs.set(scope, outputStore);
            services.set(scope, new ImageService(config, { cache, outputs: outputStore, diagnostics, scope }));
        }
        return { cache: caches.get(scope), outputs: outputs.get(scope), service: services.get(scope), scope };
    };
    const routeEvent = (request, event) => recordDiagnostic(diagnostics, { scope: diagnosticsScope(request), ...event });
    state = { config, baseConfig, configPath, managedPath, store, caches, outputs, services, diagnostics };

    router.get('/image/:prompt(*)', asyncRoute(async (request, response) => {
        try {
            const { service } = await getUserState(request);
            const result = await service.generate(generationInput(request, true), { action: 'image' });
            return sendImage(request, response, result, config);
        } catch (rawError) {
            const error = rawError instanceof PluginError ? rawError : new PluginError('Image generation failed', { cause: rawError });
            const imageEligible = ['rate_limit', 'safety', 'timeout', 'upstream_error', 'connection_error', 'invalid_upstream_response', 'response_too_large'].includes(error.code);
            const fallback = imageEligible ? await errorImage(config, error) : null;
            if (fallback) {
                response.set('X-Image-Error', error.code);
                const requestedProfile = generationInput(request, true).profile || config.defaultProfile;
                const provenance = rawError?.imageProvenance ?? { requestedProfile, effectiveProfile: requestedProfile };
                return sendImage(request, response, { ...fallback, ...provenance }, config);
            }
            return response.status(error.status).type('text/plain').send(`${error.code}: ${error.message}`);
        }
    }));

    router.post('/generate', asyncRoute(async (request, response) => {
        const { service } = await getUserState(request);
        const result = await service.generate(generationInput(request), { action: 'generate' });
        return sendImage(request, response, result, config);
    }));

    const outputContract = result => ({
        outputId: result.outputId ?? result.key,
        requestKey: result.requestKey ?? result.metadata?.requestKey ?? result.key,
        outputUrl: `/api/plugins/image-schema/outputs/${encodeURIComponent(result.outputId ?? result.key)}`,
        metadata: {
            mime: result.mime,
            bytes: result.data.length,
            etag: result.etag,
            createdAt: result.metadata?.createdAt ?? result.createdAt ?? null,
            cached: Boolean(result.cached),
            requestedProfile: result.requestedProfile ?? result.metadata?.requestedProfile ?? null,
            effectiveProfile: result.effectiveProfile ?? result.metadata?.effectiveProfile ?? result.metadata?.profile ?? null,
            fallbackReason: result.fallbackReason ?? result.metadata?.fallbackReason ?? null,
            revisionOf: result.metadata?.revisionOf ?? null,
        },
    });
    const resolveOutput = async (request, response, forcedRegenerate = false, forcedMigration = false) => {
        const body = exactBody(request, new Set(['request', 'regenerate']));
        if (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') {
            throw new PluginError('regenerate must be boolean', { status: 400, code: 'invalid_request' });
        }
        const regenerate = forcedRegenerate || body.regenerate === true;
        const { service, outputs: outputStore } = await getUserState(request);
        if (!outputStore.enabled) throw new PluginError('Durable outputs are disabled', { status: 503, code: 'outputs_disabled' });
        const result = await service.generate(generationInput(request), {
            // A configured cross-user accelerator is a legacy compatibility
            // option. Never read it while resolving user-owned durable output.
            bypassCache: regenerate || config.cache?.perUser === false,
            regenerate,
            // Ordinary resolve only considers exact profile fingerprints and
            // configured aliases. Profile-agnostic recovery requires the explicit
            // migration endpoint and can never happen silently on reload.
            migrateExisting: forcedMigration && !regenerate,
            action: regenerate ? 'output-regenerate' : forcedMigration ? 'output-migrate' : 'output-resolve',
        });
        return response.json(outputContract(result));
    };

    // JSON resolution is reload-safe by default. Provider regeneration is only
    // possible through an explicit flag or the explicit regeneration endpoint.
    router.post('/resolve', requireAuthenticated, asyncRoute(resolveOutput));
    router.post('/outputs/resolve', requireAuthenticated, asyncRoute(resolveOutput));
    router.post('/outputs/regenerate', requireAuthenticated, asyncRoute((request, response) => resolveOutput(request, response, true)));
    router.post('/outputs/migrate', requireAuthenticated, asyncRoute((request, response) => resolveOutput(request, response, false, true)));

    router.get('/status', (_request, response) => response.json({ ok: true, version: '1.5.0', ...profilesPublicView(config) }));
    router.get('/profiles', (_request, response) => response.json(profilesPublicView(config)));
    // Compatibility route used by existing clients; it remains read-only despite POST.
    router.post('/profiles', (_request, response) => response.json(profilesPublicView(config)));

    router.get('/providers/config', (request, response) => {
        routeEvent(request, { event: 'provider.config', action: 'read', status: 200 });
        return response.json(contractConfigView(store.view()));
    });
    router.post('/providers/profile/save', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['profile', 'previousName']));
        const { name, profile } = contractProfile(body.profile);
        const previousName = body.previousName === undefined ? name : validateProfileName(body.previousName);
        await store.save(name, profile, previousName);
        routeEvent(request, { event: 'provider.profile', action: 'save', profile: name, status: 200 });
        return response.json({ ok: true, name });
    }));
    router.post('/providers/profile/delete', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['name']));
        const name = validateProfileName(body.name);
        await store.delete(name);
        routeEvent(request, { event: 'provider.profile', action: 'delete', profile: name, status: 200 });
        return response.json({ ok: true, name });
    }));
    router.post('/providers/default', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['name']));
        const name = validateProfileName(body.name);
        await store.setDefault(name);
        routeEvent(request, { event: 'provider.default', action: 'set', profile: name, status: 200 });
        return response.json({ ok: true, defaultProfile: name });
    }));
    router.post('/providers/routing', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['enabled', 'fallbackProfile', 'fallbackOn']));
        const view = await store.setRouting(body);
        routeEvent(request, { event: 'provider.routing', action: body.enabled ? 'enable' : 'disable', profile: body.fallbackProfile || undefined, status: 200 });
        return response.json({ ok: true, routing: view.routing });
    }));
    router.post('/providers/secret', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['name', 'apiKey', 'clear']));
        const name = validateProfileName(body.name);
        if (body.clear === true) {
            if (body.apiKey !== undefined) throw new PluginError('apiKey and clear cannot be combined', { status: 400, code: 'invalid_request' });
            await store.deleteSecret(name);
        } else {
            if (body.clear !== undefined) throw new PluginError('clear must be true when provided', { status: 400, code: 'invalid_request' });
            const profile = config.profiles[name];
            if (!profile) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            const secret = profile.type === 'generic'
                ? { headerName: 'Authorization', value: `Bearer ${body.apiKey ?? ''}` }
                : { apiKey: body.apiKey };
            await store.replaceSecret(name, secret);
        }
        routeEvent(request, { event: 'provider.secret', action: body.clear === true ? 'clear' : 'replace', profile: name, status: 200 });
        return response.json({ ok: true, name, apiKeyConfigured: body.clear !== true });
    }));
    router.post('/providers/comfy/analyze', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['url', 'workflow']));
        const invalid = message => new PluginError(message, { status: 400, code: 'invalid_request' });
        const workflow = validateComfyWorkflow(body.workflow, 'workflow', invalid);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let upstream;
        try {
            upstream = await fetch(comfyObjectInfoUrl(body.url), {
                method: 'GET',
                headers: { accept: 'application/json' },
                redirect: 'follow',
                signal: controller.signal,
            });
        } catch (error) {
            const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
            const protocolHint = String(body.url ?? '').startsWith('https:')
                ? ' Check whether ComfyUI is using plain HTTP; its default listener is http://.'
                : '';
            throw new PluginError(timeout ? 'ComfyUI object_info request timed out' : `Could not fetch ComfyUI object_info.${protocolHint}`, { status: timeout ? 504 : 502, code: timeout ? 'timeout' : 'connection_error', cause: error });
        } finally {
            clearTimeout(timer);
        }
        if (!upstream.ok) throw new PluginError(`ComfyUI object_info returned HTTP ${upstream.status}`, { status: 502, code: 'upstream_error' });
        const objectInfo = await limitedJson(upstream);
        const analysis = analyzeComfyWorkflow(workflow, objectInfo);
        routeEvent(request, { event: 'provider.comfy.analyze', action: 'analyze', status: 200 });
        return response.json({ ok: true, analysis });
    }));
    router.post('/providers/profile/test', requireAdmin, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['profile', 'prompt']));
        const { name, profile } = contractProfile(body.profile);
        const existing = config.profiles[name];
        const inheritedSecret = existing?.type === profile.type
            ? {
                ...(existing.apiKey ? { apiKey: existing.apiKey } : {}),
                ...(existing.headers ? { headers: structuredClone(existing.headers) } : {}),
            }
            : {};
        const testProfile = { ...profile, ...inheritedSecret };
        const testConfig = validateConfig({ ...structuredClone(config), defaultProfile: name, profiles: { ...structuredClone(config.profiles), [name]: testProfile } });
        const testService = new ImageService(testConfig, { cache: null, diagnostics, scope: diagnosticsScope(request) });
        const prompt = body.prompt === undefined ? 'A small red circle on a plain white background' : body.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) throw new PluginError('prompt must be a non-empty string', { status: 400, code: 'invalid_request' });
        const result = await testService.generate({ profile: name, prompt }, { bypassCache: true, action: 'provider-test' });
        return response.json({ ok: true, profile: name, mime: result.mime, bytes: result.data.length });
    }));

    router.post('/cache/stats', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        const result = { ...(await cache.stats()), inflight: service.inflight.size };
        routeEvent(request, { event: 'cache.manage', action: 'stats', status: 200, bytes: result.bytes });
        return response.json(result);
    }));
    router.post('/cache/clear', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        let result;
        let profile;
        if (request.body?.all === true || !request.body?.request) {
            result = await cache.clear();
        } else {
            const prepared = service.prepare(generationInput(request));
            profile = prepared.request.profile;
            result = await cache.delete(prepared.key);
        }
        routeEvent(request, { event: 'cache.manage', action: 'clear', profile, status: 200 });
        return response.json(result);
    }));
    router.post('/cache/regenerate', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        const input = generationInput(request);
        const prepared = service.prepare(input);
        await cache.delete(prepared.key);
        // Outputs remain authoritative: this warms internal cache from durable
        // bytes rather than silently replacing an existing generated artifact.
        const result = await service.generate(input, { bypassCache: true, action: 'cache-regenerate' });
        return response.json({ ok: true, key: result.key, profile: result.request.profile, seed: result.request.seed, mime: result.mime, bytes: result.data.length });
    }));
    router.get('/outputs/stats', asyncRoute(async (request, response) => {
        const { outputs: outputStore } = await getUserState(request);
        const result = await outputStore.stats();
        routeEvent(request, { event: 'output.manage', action: 'stats', status: 200, bytes: result.bytes });
        return response.json(result);
    }));
    router.post('/outputs/stats', asyncRoute(async (request, response) => {
        const { outputs: outputStore } = await getUserState(request);
        const result = await outputStore.stats();
        routeEvent(request, { event: 'output.manage', action: 'stats', status: 200, bytes: result.bytes });
        return response.json(result);
    }));
    const galleryItem = entry => {
        const metadata = entry.metadata;
        const safeRequest = {};
        for (const key of ['profile', 'width', 'height', 'seed', 'model', 'quality', 'outputFormat', 'background', 'enhance', 'aspectRatio', 'imageSize', 'temperature', 'personGeneration']) {
            const value = metadata.params?.[key];
            if (value !== undefined && value !== null && value !== '') safeRequest[key] = value;
        }
        const id = entry.outputId;
        return {
            outputId: id,
            requestKey: metadata.requestKey ?? id,
            revisionOf: metadata.revisionOf ?? null,
            createdAt: metadata.createdAt,
            mime: metadata.mime,
            bytes: entry.bytes,
            etag: metadata.etag ?? null,
            requestedProfile: metadata.requestedProfile ?? metadata.params?.profile ?? null,
            effectiveProfile: metadata.effectiveProfile ?? metadata.profile ?? null,
            fallbackReason: metadata.fallbackReason ?? null,
            ...(config.outputs?.includePrompt === true && Object.hasOwn(metadata, 'prompt') ? { prompt: metadata.prompt } : {}),
            request: safeRequest,
            outputUrl: `/api/plugins/image-schema/outputs/${encodeURIComponent(id)}`,
            thumbnailUrl: `/api/plugins/image-schema/outputs/${encodeURIComponent(id)}/thumbnail`,
            thumbnail: { kind: 'original', resized: false },
        };
    };

    router.get('/outputs', requireAuthenticated, asyncRoute(async (request, response) => {
        const { outputs: outputStore } = await getUserState(request);
        const page = await outputStore.list({ limit: request.query?.limit ?? 40, cursor: request.query?.cursor ?? null });
        return response.json({ items: page.items.map(galleryItem), nextCursor: page.nextCursor });
    }));

    const exactOutput = async (request, response, thumbnail = false) => {
        const { outputs: outputStore } = await getUserState(request);
        const id = outputId(request.params?.outputId);
        const result = await outputStore.get(id);
        if (!result) throw new PluginError('Output not found', { status: 404, code: 'output_not_found' });
        if (thumbnail) response.set({ 'X-Thumbnail-Source': 'original', 'X-Thumbnail-Contract': 'original-v1' });
        return sendImage(request, response, {
            ...result,
            outputId: id,
            requestedProfile: result.metadata?.requestedProfile,
            effectiveProfile: result.metadata?.effectiveProfile ?? result.metadata?.profile,
            fallbackReason: result.metadata?.fallbackReason,
        }, config, { privateCache: true });
    };
    router.get('/outputs/:outputId/thumbnail', requireAuthenticated, asyncRoute((request, response) => exactOutput(request, response, true)));
    router.get('/outputs/:outputId', requireAuthenticated, asyncRoute(exactOutput));

    const listReferences = async (request, response, chatIdValue) => {
        const { outputs: outputStore } = await getUserState(request);
        const chatId = boundedIdentifier(chatIdValue, 'chatId');
        return response.json({ chatId, references: await outputStore.listReferences(chatId) });
    };
    router.get('/references/:chatId', requireAuthenticated, asyncRoute((request, response) => listReferences(request, response, request.params?.chatId)));
    router.post('/references/list', requireAuthenticated, asyncRoute((request, response) => {
        const body = exactBody(request, new Set(['chatId']));
        return listReferences(request, response, body.chatId);
    }));
    router.post('/references/upsert', requireAuthenticated, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['chatId', 'messageId', 'swipeKey', 'slotId', 'activeOutputId', 'historyIds']));
        const identity = referenceIdentity(body);
        const activeOutputId = outputId(body.activeOutputId, 'activeOutputId');
        if (!Array.isArray(body.historyIds) || body.historyIds.length > 200) throw new PluginError('historyIds must be an array of at most 200 output IDs', { status: 400, code: 'invalid_request' });
        const historyIds = [...new Set(body.historyIds.map((id, index) => outputId(id, `historyIds[${index}]`)))];
        if (!historyIds.includes(activeOutputId)) throw new PluginError('historyIds must contain activeOutputId', { status: 400, code: 'invalid_request' });
        const { outputs: outputStore } = await getUserState(request);
        for (const id of historyIds) {
            if (!await outputStore.get(id)) throw new PluginError('Referenced output not found', { status: 404, code: 'output_not_found' });
        }
        return response.json({ reference: await outputStore.upsertReference({ ...identity, activeOutputId, historyIds }) });
    }));
    router.post('/references/remove', requireAuthenticated, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['chatId', 'messageId', 'swipeKey', 'slotId']));
        const identity = referenceIdentity(body);
        const { outputs: outputStore } = await getUserState(request);
        return response.json(await outputStore.removeReference(identity));
    }));
    router.post('/outputs/delete', requireAuthenticated, asyncRoute(async (request, response) => {
        const body = exactBody(request, new Set(['outputId', 'family', 'force']));
        if (body.family !== undefined && typeof body.family !== 'boolean') throw new PluginError('family must be boolean', { status: 400, code: 'invalid_request' });
        if (body.force !== undefined && typeof body.force !== 'boolean') throw new PluginError('force must be boolean', { status: 400, code: 'invalid_request' });
        const { outputs: outputStore, cache } = await getUserState(request);
        const id = outputId(body.outputId);
        const existing = await outputStore.get(id);
        if (!existing) throw new PluginError('Output not found', { status: 404, code: 'output_not_found' });
        const result = await outputStore.delete(id, { family: body.family === true, force: body.force === true });
        if (body.family === true) await cache.delete(existing.metadata?.requestKey ?? id);
        routeEvent(request, { event: 'output.manage', action: body.family === true ? 'delete-family' : 'delete', status: 200 });
        return response.json(result);
    }));
    router.post('/outputs/clear', asyncRoute(async (request, response) => {
        const { outputs: outputStore, cache, service } = await getUserState(request);
        const force = request.body?.force === true;
        if (request.body?.force !== undefined && typeof request.body.force !== 'boolean') throw new PluginError('force must be boolean', { status: 400, code: 'invalid_request' });
        let result;
        let profile;
        if (request.body?.all === true || !request.body?.request) {
            result = await outputStore.clear({ force });
        } else {
            const prepared = service.prepare(generationInput(request));
            profile = prepared.request.profile;
            result = await outputStore.delete(prepared.key, { family: true, force });
            await cache.delete(prepared.key);
        }
        routeEvent(request, { event: 'output.manage', action: 'clear', profile, status: 200 });
        return response.json(result);
    }));
    router.post('/test', asyncRoute(async (request, response) => {
        const { service } = await getUserState(request);
        const input = generationInput(request);
        if (!input.prompt) input.prompt = 'A small red circle on a plain white background';
        const result = await service.generate(input, { bypassCache: true, action: 'test' });
        return response.json({
            ok: true,
            profile: result.request.profile,
            mime: result.mime,
            bytes: result.data.length,
            cached: result.cached,
            seed: result.request.seed ?? null,
        });
    }));

    router.get('/diagnostics/recent', (request, response) => {
        const adminGlobal = isDiagnosticsAdmin(request) && String(request.query?.scope ?? '').toLowerCase() === 'global';
        const scope = diagnosticsScope(request);
        return response.json({
            scope: adminGlobal ? 'global' : 'user',
            limit: diagnostics.limit,
            events: diagnostics.recent({ scope, global: adminGlobal, limit: request.query?.limit }),
            summary: diagnostics.summary({ scope, global: adminGlobal }),
        });
    });
    router.post('/diagnostics/clear', requireExplicitAdmin, asyncRoute(async (request, response) => {
        const userOnly = request.body?.scope === 'user';
        if (request.body?.scope !== undefined && !['user', 'global'].includes(request.body.scope)) {
            throw new PluginError('scope must be user or global', { status: 400, code: 'invalid_request' });
        }
        const removed = diagnostics.clear({ scope: diagnosticsScope(request), global: !userOnly });
        return response.json({ ok: true, scope: userOnly ? 'user' : 'global', removed });
    }));

    router.use((error, request, response, _next) => {
        const normalized = error instanceof PluginError ? error : new PluginError('Internal image server error', { status: 500, code: 'internal_error', cause: error });
        routeEvent(request, { level: 'error', event: 'route.error', action: String(request.method ?? '').toLowerCase(), status: normalized.status, code: normalized.code });
        console.error(`[${info.id}] request failed`, { method: request.method, path: request.route?.path ?? 'unknown', status: normalized.status, code: normalized.code });
        if (response.headersSent) return response.end();
        return response.status(normalized.status).json({ error: { code: normalized.code, message: normalized.message } });
    });

    console.log(`[${info.id}] loaded ${Object.keys(config.profiles).length} profile(s) from base and managed configuration`);
}

export async function exit() {
    if (state) {
        const inflight = [...state.services.values()].reduce((total, service) => total + service.inflight.size, 0);
        console.log(`[${info.id}] stopped; ${inflight} generation(s) were in flight`);
    }
    state = null;
}

export default { info, init, exit };
