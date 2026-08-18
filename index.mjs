import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { DiskCache, ImageService, PluginError, expandEnv, profilePublicView, sniffMime, validateConfig } from './core.mjs';

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

function publicProfiles(config) {
    return {
        defaultProfile: config.defaultProfile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => profilePublicView(name, profile, name === config.defaultProfile)),
    };
}

export async function init(router) {
    if (state) throw new PluginError('Image server plugin is already initialized', { status: 500, code: 'config_error' });
    const { config, configPath } = await loadConfig();
    const cacheDirectorySetting = config.cache?.directory ?? './cache';
    const configuredCacheDirectory = path.isAbsolute(cacheDirectorySetting) ? cacheDirectorySetting : path.resolve(pluginDirectory, cacheDirectorySetting);
    const caches = new Map();
    const services = new Map();
    const getUserState = async request => {
        const handle = String(request.user?.profile?.handle ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_');
        if (!caches.has(handle)) {
            const directory = config.cache?.perUser === false ? configuredCacheDirectory : path.join(configuredCacheDirectory, handle);
            const cache = new DiskCache({ directory, enabled: config.cache?.enabled !== false, ttlSeconds: config.cache?.ttlSeconds ?? null });
            await cache.init();
            caches.set(handle, cache);
            services.set(handle, new ImageService(config, { cache }));
        }
        return { cache: caches.get(handle), service: services.get(handle) };
    };
    state = { config, configPath, caches, services };

    router.get('/image/:prompt(*)', asyncRoute(async (request, response) => {
        try {
            const { service } = await getUserState(request);
            const result = await service.generate(generationInput(request, true));
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
        const result = await service.generate(generationInput(request));
        return sendImage(request, response, result, config);
    }));

    router.get('/status', (_request, response) => response.json({ ok: true, version: '1.0.0', ...publicProfiles(config) }));
    router.get('/profiles', (_request, response) => response.json(publicProfiles(config)));
    router.post('/profiles', (_request, response) => response.json(publicProfiles(config)));
    router.post('/cache/stats', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        return response.json({ ...(await cache.stats()), inflight: service.inflight.size });
    }));
    router.post('/cache/clear', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        if (request.body?.all === true || !request.body?.request) return response.json(await cache.clear());
        const prepared = service.prepare(generationInput(request));
        return response.json(await cache.delete(prepared.key));
    }));
    router.post('/cache/regenerate', asyncRoute(async (request, response) => {
        const { cache, service } = await getUserState(request);
        const input = generationInput(request);
        const prepared = service.prepare(input);
        await cache.delete(prepared.key);
        const result = await service.generate(input, { bypassCache: true });
        return response.json({ ok: true, key: result.key, profile: result.request.profile, seed: result.request.seed, mime: result.mime, bytes: result.data.length });
    }));
    router.post('/test', asyncRoute(async (request, response) => {
        const { service } = await getUserState(request);
        const input = generationInput(request);
        if (!input.prompt) input.prompt = 'A small red circle on a plain white background';
        const result = await service.generate(input, { bypassCache: true });
        return response.json({
            ok: true,
            profile: result.request.profile,
            mime: result.mime,
            bytes: result.data.length,
            cached: result.cached,
            seed: result.request.seed ?? null,
        });
    }));

    router.use((error, request, response, _next) => {
        const normalized = error instanceof PluginError ? error : new PluginError('Internal image server error', { status: 500, code: 'internal_error', cause: error });
        console.error(`[${info.id}] ${request.method} ${request.path}:`, normalized.code, normalized.message);
        if (response.headersSent) return response.end();
        return response.status(normalized.status).json({ error: { code: normalized.code, message: normalized.message } });
    });

    console.log(`[${info.id}] loaded ${Object.keys(config.profiles).length} profile(s) from ${configPath}`);
}

export async function exit() {
    if (state) {
        const inflight = [...state.services.values()].reduce((total, service) => total + service.inflight.size, 0);
        console.log(`[${info.id}] stopped; ${inflight} generation(s) were in flight`);
    }
    state = null;
}

export default { info, init, exit };
