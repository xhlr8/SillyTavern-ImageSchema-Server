import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    DiskCache,
    ImageService,
    canonicalize,
    expandEnv,
    fingerprint,
    geminiSseAdapter,
    genericAdapter,
    normalizeRequest,
    openAiAdapter,
    sniffMime,
} from '../core.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('canonical fingerprints ignore object insertion order but retain seed semantics', () => {
    assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
    assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
    assert.notEqual(fingerprint({ prompt: 'x', seed: 0 }), fingerprint({ prompt: 'x' }));
});

test('environment expansion supports defaults and rejects missing secrets', () => {
    assert.deepEqual(expandEnv({ key: '${KEY}', optional: '${NONE:-fallback}' }, { KEY: 'secret' }), { key: 'secret', optional: 'fallback' });
    assert.throws(() => expandEnv('${MISSING}', {}), /Required environment variable MISSING/);
});

test('request normalization has seed but rejects a separate id concept', () => {
    const config = { defaultProfile: 'p', profiles: { p: { type: 'generic', url: 'https://example.test', defaults: {} } } };
    assert.equal(normalizeRequest({ prompt: 'cat', seed: '0' }, config).request.seed, 0);
    assert.throws(() => normalizeRequest({ prompt: 'cat', id: 'abc' }, config), /id parameter is not supported/);
});

test('empty allowedModels disables model overrides without rejecting the configured model', () => {
    const config = { defaultProfile: 'p', profiles: { p: { type: 'openai', url: 'https://example.test', model: 'gpt-image-2', allowedModels: [], defaults: {} } } };
    assert.equal(normalizeRequest({ prompt: 'cat' }, config).request.model, 'gpt-image-2');
    assert.throws(() => normalizeRequest({ prompt: 'cat', model: 'other' }, config), /does not allow/);
});

test('OpenAI adapter sends configured URL and decodes b64_json', async () => {
    let captured;
    const fetchImpl = async (url, options) => {
        captured = { url: String(url), options };
        return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] });
    };
    const result = await openAiAdapter({
        type: 'openai', url: 'https://api.example.test/images', apiKey: 'server-secret', model: 'model', defaults: {},
    }, { prompt: 'cat', width: 1200, height: 800, model: 'model', quality: 'high', outputFormat: 'png' }, { fetchImpl });
    assert.equal(result.mime, 'image/png');
    assert.deepEqual(result.data, PNG);
    assert.equal(captured.url, 'https://api.example.test/images');
    assert.equal(captured.options.headers.authorization, 'Bearer server-secret');
    const body = JSON.parse(captured.options.body);
    assert.equal(body.prompt, 'cat');
    assert.equal(body.size, '1536x1024');
});

test('Gemini SSE adapter reads inline image across standard SSE events', async () => {
    const sse = [
        ': keepalive',
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'working' }] } }] })}`,
        '',
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] })}`,
        '',
    ].join('\n');
    let capturedUrl;
    const result = await geminiSseAdapter({
        type: 'gemini-sse', url: 'https://gemini.example.test/stream', apiKey: 'secret', queryApiKey: true,
    }, { prompt: 'cat', width: 512, height: 512, negative: '', model: 'gemini-image' }, {
        fetchImpl: async url => {
            capturedUrl = String(url);
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
    });
    assert.equal(result.mime, 'image/png');
    assert.match(capturedUrl, /key=secret/);
});

test('generic GET and POST adapters render only configured requests', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
        seen.push({ url: String(url), options });
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const request = { prompt: 'a cat/dog', width: 640, height: 480, seed: 12, negative: '' };
    await genericAdapter({ type: 'generic', method: 'GET', url: 'https://fixed.test/img/{prompt}', query: { seed: '{seed}', omitted: '{negative}' } }, request, { fetchImpl });
    await genericAdapter({ type: 'generic', method: 'POST', url: 'https://fixed.test/img', body: { text: '{prompt}', width: '{width}' } }, request, { fetchImpl });
    assert.equal(seen[0].url, 'https://fixed.test/img/a%20cat%2Fdog?seed=12');
    assert.deepEqual(JSON.parse(seen[1].options.body), { text: 'a cat/dog', width: 640 });
    assert.equal(seen[1].options.method, 'POST');
});

test('generic JSON response supports base64 path and MIME path', async () => {
    const result = await genericAdapter({
        type: 'generic', method: 'POST', url: 'https://fixed.test', body: {}, responseImagePath: 'images[0].data', responseMimePath: 'images.0.mime', responseEncoding: 'base64',
    }, { prompt: 'cat' }, { fetchImpl: async () => jsonResponse({ images: [{ data: PNG.toString('base64'), mime: 'image/png' }] }) });
    assert.deepEqual(result.data, PNG);
    assert.equal(result.mime, 'image/png');
});

test('disk cache persists all entries by default and expires only when explicitly configured', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'st-image-cache-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const persistentCache = new DiskCache({ directory });
    await persistentCache.init();
    const entry = await persistentCache.set('a'.repeat(64), { data: PNG, mime: 'image/png' });
    assert.equal(entry.cached, false);
    const files = persistentCache.paths('a'.repeat(64));
    const metadata = JSON.parse(await readFile(files.meta, 'utf8'));
    metadata.createdAt = Date.now() - 5000;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(files.meta, JSON.stringify(metadata)));
    assert.equal((await persistentCache.get('a'.repeat(64))).cached, true);
    assert.equal((await persistentCache.stats()).ttlSeconds, null);

    const expiringCache = new DiskCache({ directory, ttlSeconds: 1 });
    await expiringCache.set('b'.repeat(64), { data: PNG, mime: 'image/png' });
    const expiringFiles = expiringCache.paths('b'.repeat(64));
    const expiringMeta = JSON.parse(await readFile(expiringFiles.meta, 'utf8'));
    expiringMeta.createdAt = Date.now() - 5000;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(expiringFiles.meta, JSON.stringify(expiringMeta)));
    assert.equal(await expiringCache.get('b'.repeat(64)), null);
    assert.deepEqual((await persistentCache.stats()).entries, 1);
    assert.equal((await persistentCache.clear()).removed, 2);
});

test('ImageService deduplicates seedless requests and preserves the first random result across service reloads', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'st-image-dedupe-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fetchImpl = async () => {
        calls++;
        await gate;
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const config = {
        defaultProfile: 'fixed',
        cache: { enabled: true, ttlSeconds: null },
        profiles: { fixed: { type: 'generic', method: 'GET', url: 'https://fixed.test/image', defaults: { width: 512, height: 512 } } },
    };
    const cache = new DiskCache({ directory });
    await cache.init();
    const service = new ImageService(config, { cache, fetchImpl });
    const first = service.generate({ prompt: 'same' });
    const second = service.generate({ prompt: 'same' });
    for (let attempt = 0; attempt < 20 && calls === 0; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.etag, b.etag);
    assert.equal(calls, 1);

    const reloadedService = new ImageService(config, {
        cache: new DiskCache({ directory }),
        fetchImpl: async () => { throw new Error('cache should survive service reload'); },
    });
    const reloaded = await reloadedService.generate({ prompt: 'same' });
    assert.equal(reloaded.cached, true);
    assert.equal(reloaded.etag, a.etag);
    assert.equal(calls, 1);
});

test('MIME sniffing recognizes PNG and does not trust non-image hints', () => {
    assert.equal(sniffMime(PNG), 'image/png');
    assert.throws(() => sniffMime(Buffer.from('not an image'), 'text/plain'), /recognized image/);
});
