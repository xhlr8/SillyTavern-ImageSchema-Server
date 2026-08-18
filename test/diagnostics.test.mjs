import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ImageService } from '../core.mjs';
import { ActivityDiagnostics, diagnosticsContract } from '../diagnostics.mjs';
import { exit, init } from '../index.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

class FakeRouter {
    constructor() {
        this.routes = [];
        this.middleware = [];
    }

    get(pathname, ...handlers) { this.routes.push({ method: 'GET', pathname, handlers }); }
    post(pathname, ...handlers) { this.routes.push({ method: 'POST', pathname, handlers }); }
    use(handler) { this.middleware.push(handler); }

    handler(method, pathname) {
        const route = this.routes.find(item => item.method === method && item.pathname === pathname);
        assert.ok(route, `missing ${method} ${pathname}`);
        return route.handlers.at(-1);
    }
}

function responseCapture() {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        status(value) { this.statusCode = value; return this; },
        set(name, value) {
            if (typeof name === 'object') Object.assign(this.headers, name);
            else this.headers[name] = value;
            return this;
        },
        type() { return this; },
        json(value) { this.body = value; return value; },
        send(value) { this.body = value; return value; },
        end() { return this; },
    };
}

test('diagnostics enforce allowlisted fields, redact unsafe input, and remain bounded', () => {
    const diagnostics = new ActivityDiagnostics({ limit: 3, now: () => new Date('2025-01-02T03:04:05.000Z') });
    const secret = 'never-store-this-secret';
    for (let index = 0; index < 5; index++) {
        diagnostics.record({
            event: `generation.${index}`,
            level: index === 4 ? 'error' : 'info',
            action: 'generate',
            profile: index === 4 ? `unsafe/${secret}` : 'safe-profile',
            cache: index % 2 ? 'hit' : 'miss',
            durationMs: index,
            status: index === 4 ? 502 : 200,
            code: index === 4 ? 'connection_error' : undefined,
            bytes: 12,
            scope: 'user-a',
            prompt: `private prompt ${secret}`,
            negative: `private negative ${secret}`,
            url: `https://example.test/?key=${secret}`,
            apiKey: secret,
            headers: { authorization: secret },
            body: secret,
            error: new Error(`raw upstream ${secret}`),
        });
    }

    const events = diagnostics.recent({ scope: 'user-a' });
    assert.deepEqual(events.map(event => event.event), ['generation.2', 'generation.3', 'generation.4']);
    assert.equal(events[2].profile, undefined, 'unsafe profile labels are omitted rather than copied');
    assert.deepEqual(Object.keys(events[2]).sort(), ['action', 'bytes', 'cache', 'code', 'durationMs', 'event', 'level', 'status', 'timestamp']);
    const serialized = JSON.stringify(events);
    for (const forbidden of [secret, 'prompt', 'negative', 'https://', 'apiKey', 'headers', 'body', 'raw upstream']) {
        assert.equal(serialized.includes(forbidden), false, `diagnostics contained forbidden value: ${forbidden}`);
    }
    assert.deepEqual([...diagnosticsContract.fields].sort(), ['action', 'bytes', 'cache', 'code', 'durationMs', 'event', 'level', 'profile', 'status', 'timestamp'].sort());
});

test('diagnostics are user scoped by default and support explicit global clear', () => {
    const diagnostics = new ActivityDiagnostics({ limit: 10 });
    diagnostics.record({ event: 'one', scope: 'user-a' });
    diagnostics.record({ event: 'two', scope: 'user-b' });
    assert.deepEqual(diagnostics.recent({ scope: 'user-a' }).map(event => event.event), ['one']);
    assert.equal(diagnostics.summary({ scope: 'user-b' }).total, 1);
    assert.equal(diagnostics.clear({ scope: 'user-a' }), 1);
    assert.deepEqual(diagnostics.recent({ global: true }).map(event => event.event), ['two']);
    assert.equal(diagnostics.clear({ global: true }), 1);
    assert.equal(diagnostics.recent({ global: true }).length, 0);
});

test('ImageService records sanitized cache and upstream success events', async t => {
    const diagnostics = new ActivityDiagnostics({ limit: 20 });
    const entries = new Map();
    const cache = {
        async get(key) { return entries.get(key) ?? null; },
        async set(key, result) {
            const entry = { ...result, etag: 'etag', cached: false, createdAt: Date.now() };
            entries.set(key, { ...entry, cached: true });
            return entry;
        },
    };
    const service = new ImageService({
        defaultProfile: 'safe',
        profiles: { safe: { type: 'generic', method: 'GET', url: 'https://provider.example.test/image?secret=query-secret', defaults: {} } },
    }, {
        cache,
        diagnostics,
        scope: 'user-a',
        fetchImpl: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });

    await service.generate({ prompt: 'private prompt' });
    await service.generate({ prompt: 'private prompt' });
    const events = diagnostics.recent({ scope: 'user-a' });
    assert.ok(events.some(event => event.event === 'upstream.request' && event.status === 200 && event.profile === 'safe'));
    assert.ok(events.some(event => event.event === 'generation.complete' && event.cache === 'miss' && event.bytes === PNG.length));
    assert.ok(events.some(event => event.event === 'generation.complete' && event.cache === 'hit'));
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('private prompt'), false);
    assert.equal(serialized.includes('provider.example.test'), false);
    assert.equal(serialized.includes('query-secret'), false);
});

test('ImageService records only stable codes when upstream throws raw secrets', async () => {
    const diagnostics = new ActivityDiagnostics({ limit: 20 });
    const service = new ImageService({
        defaultProfile: 'safe',
        profiles: { safe: { type: 'generic', method: 'GET', url: 'https://provider.example.test/image', defaults: {} } },
    }, {
        cache: null,
        diagnostics,
        scope: 'user-a',
        fetchImpl: async () => { throw new Error('RAW-UPSTREAM-SECRET'); },
    });
    await assert.rejects(service.generate({ prompt: 'PRIVATE-PROMPT' }), error => error.code === 'connection_error');
    const serialized = JSON.stringify(diagnostics.recent({ scope: 'user-a' }));
    assert.equal(serialized.includes('RAW-UPSTREAM-SECRET'), false);
    assert.equal(serialized.includes('PRIVATE-PROMPT'), false);
    assert.match(serialized, /connection_error/);
});

test('provider and diagnostics routes expose only sanitized user-scoped activity', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'image-diagnostics-route-'));
    t.after(async () => {
        await exit();
        await rm(directory, { recursive: true, force: true });
    });
    const configPath = path.join(directory, 'config.yaml');
    const managedPath = path.join(directory, 'managed.json');
    await writeFile(configPath, [
        'defaultProfile: safe',
        'cache:',
        '  enabled: false',
        'profiles:',
        '  safe:',
        '    type: generic',
        '    method: GET',
        '    url: https://provider.example.test/image?token=route-secret',
    ].join('\n'));
    const previousConfig = process.env.SILLYTAVERN_IMAGE_CONFIG;
    const previousManaged = process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG;
    process.env.SILLYTAVERN_IMAGE_CONFIG = configPath;
    process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = managedPath;
    t.after(() => {
        if (previousConfig === undefined) delete process.env.SILLYTAVERN_IMAGE_CONFIG;
        else process.env.SILLYTAVERN_IMAGE_CONFIG = previousConfig;
        if (previousManaged === undefined) delete process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG;
        else process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = previousManaged;
    });

    const router = new FakeRouter();
    await init(router);
    const request = { method: 'GET', query: {}, user: { profile: { handle: 'alice', admin: false } } };
    router.handler('GET', '/providers/config')(request, responseCapture());
    const response = responseCapture();
    router.handler('GET', '/diagnostics/recent')(request, response);

    assert.equal(response.body.scope, 'user');
    assert.ok(response.body.events.some(event => event.event === 'provider.config' && event.action === 'read'));
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('provider.example.test'), false);
    assert.equal(serialized.includes('route-secret'), false);
    assert.equal(serialized.includes('alice'), false, 'diagnostics do not expose the raw user handle');
});
