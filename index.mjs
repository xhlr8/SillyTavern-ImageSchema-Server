import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { DiskCache, ImageService, PluginError, expandEnv, sniffMime, validateConfig } from './core.mjs';
import { ActivityDiagnostics, diagnosticsContract, diagnosticsScope, isDiagnosticsAdmin, recordDiagnostic } from './diagnostics.mjs';
import { ManagedProfileStore, profilesPublicView, validateManagedProfile, validateProfileName } from './managed-config.mjs';

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
        ? { ...(nested.params && typeof nested.params === 'object' ? nested.params : {}), prompt: nested.text ?? nested.prompt }
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

function sendImage(request, response, result, config) {
    const etag = result.etag ?? createHash('sha256').update(result.data).digest('hex');
    const isError = Boolean(result.error);
    const ttl = config.cache?.ttlSeconds;
    const persistent = ttl === null || ttl === undefined;
    const maxAge = persistent ? 31536000 : Math.max(0, Number(ttl));
    response.set({
        'Content-Disposition': 'inline',
        'Cache-Control': isError ? 'no-store' : (persistent ? `public, max-age=${maxAge}, immutable` : `public, max-age=${maxAge}`),
        ...(isError ? {} : { ETag: `"${etag}"` }),
        'X-Content-Type-Options': 'nosniff',
        'X-Image-Cache': isError ? 'ERROR' : (result.cached ? 'HIT' : 'MISS'),
    });
    if (!isError && etagMatches(request.headers['if-none-match'], etag)) return response.status(304).end();
    response.set({
        'Content-Type': sniffMime(result.data, result.mime),
        'Content-Length': String(result.data.length),
    });
    return response.status(200).send(result.data);
}

async function errorImage(config, error) {
    const category = error.code === 'rate_limit' ? 'rateLimit'
        : error.code === 'safety' ? 'safety'
            : error.code === 'timeout' ? 'timeout'
                : error.code === 'upstream_error' || error.code === 'connection_error' ? 'upstream'
                    : 'unknown';
    const configured = config.errorImages?.[category] ?? config.errorImages?.unknown;
    if (!configured) return null;
    const file = path.isAbsolute(configured) ? configured : path.resolve(pluginDirectory, configured);
    try {
        const data = await readFile(file);
        return { data, mime: sniffMime(data), etag: createHash('sha256').update(data).digest('hex'), cached: false, error: true };
    } catch {
        return null;
    }
}

function exactBody(request, allowed) {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PluginError('Request body must be an object', { status: 400, code: 'invalid_request' });
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new PluginError(`Unsupported request field: ${key}`, { status: 400, code: 'invalid_request' });
    }
    return body;
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
    const allowed = new Set(['name', 'type', 'url', 'method', 'model', 'allowedModels', 'timeoutMs', 'defaults']);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new PluginError(`profile contains unsupported field: ${key}`, { status: 400, code: 'invalid_config' });
    const { name, ...profile } = source;
    return { name: validateProfileName(name), profile: validateManagedProfile(profile) };
}

function exactObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError(`${label} must be an object`, { status: 400, code: 'invalid_request' });
    return value;
}

function contractConfigView(view) {
    return {
        defaultProfile: view.defaultProfile,
        profiles: Object.values(view.profiles).map(profile => ({
            name: profile.name,
            type: profile.type,
            url: profile.url,
            ...(profile.type === 'generic' ? { method: profile.method ?? 'GET' } : {}),
            model: profile.model ?? '',
            allowedModels: profile.allowedModels ?? [],
            timeoutMs: profile.timeoutMs ?? 120000,
            defaults: profile.defaults ?? {},
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
    const caches = new Map();
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
            const directoryName = scope.slice(0, 32);
            const directory = config.cache?.perUser === false ? configuredCacheDirectory : path.join(configuredCacheDirectory, directoryName);
            const cache = new DiskCache({ directory, enabled: config.cache?.enabled !== false, ttlSeconds: config.cache?.ttlSeconds ?? null });
            await cache.init();
            caches.set(scope, cache);
            services.set(scope, new ImageService(config, { cache, diagnostics, scope }));
        }
        return { cache: caches.get(scope), service: services.get(scope), scope };
    };
    const routeEvent = (request, event) => recordDiagnostic(diagnostics, { scope: diagnosticsScope(request), ...event });
    state = { config, baseConfig, configPath, managedPath, store, caches, services, diagnostics };

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
                return sendImage(request, response, fallback, config);
            }
            return response.status(error.status).type('text/plain').send(`${error.code}: ${error.message}`);
        }
    }));

    router.post('/generate', asyncRoute(async (request, response) => {
        const { service } = await getUserState(request);
        const result = await service.generate(generationInput(request), { action: 'generate' });
        return sendImage(request, response, result, config);
    }));

    router.get('/status', (_request, response) => response.json({ ok: true, version: '1.1.0', ...profilesPublicView(config) }));
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
        const result = await service.generate(input, { bypassCache: true, action: 'cache-regenerate' });
        return response.json({ ok: true, key: result.key, profile: result.request.profile, seed: result.request.seed, mime: result.mime, bytes: result.data.length });
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
