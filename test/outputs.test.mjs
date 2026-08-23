import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exit, init } from '../index.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

class FakeRouter {
    constructor() { this.routes = []; this.middleware = []; }
    get(pathname, ...handlers) { this.routes.push({ method: 'GET', pathname, handlers }); }
    post(pathname, ...handlers) { this.routes.push({ method: 'POST', pathname, handlers }); }
    use(handler) { this.middleware.push(handler); }
    route(method, pathname) {
        const route = this.routes.find(item => item.method === method && item.pathname === pathname);
        assert.ok(route, `missing ${method} ${pathname}`);
        return route;
    }
}

function responseCapture() {
    return {
        statusCode: 200, body: undefined, headers: {},
        status(value) { this.statusCode = value; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        json(value) { this.body = value; return value; },
        send(value) { this.body = value; return value; },
        type() { return this; },
        end() { return this; },
    };
}

async function invoke(route, request, response = responseCapture()) {
    let index = 0;
    let error;
    const next = value => { error = value; };
    for (; index < route.handlers.length; index++) {
        await route.handlers[index](request, response, next);
        if (error) throw error;
    }
    return response;
}

async function withPlugin(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'image-output-routes-'));
    const configPath = path.join(directory, 'config.yaml');
    const managedPath = path.join(directory, 'managed.json');
    await writeFile(configPath, [
        'defaultProfile: fixed',
        'cache:',
        '  enabled: true',
        '  perUser: false',
        `  directory: ${JSON.stringify(path.join(directory, 'cache'))}`,
        'outputs:',
        '  enabled: true',
        `  directory: ${JSON.stringify(path.join(directory, 'outputs'))}`,
        'profiles:',
        '  fixed:',
        '    type: generic',
        '    method: GET',
        '    url: https://provider.example.test/image',
        '    model: old-model',
        '  fallback:',
        '    type: generic',
        '    method: GET',
        '    url: https://fallback.example.test/image',
    ].join('\n'));
    const previousConfig = process.env.SILLYTAVERN_IMAGE_CONFIG;
    const previousManaged = process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG;
    process.env.SILLYTAVERN_IMAGE_CONFIG = configPath;
    process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = managedPath;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return new Response(Buffer.concat([PNG, Buffer.from([calls])]), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    t.after(async () => {
        await exit();
        globalThis.fetch = originalFetch;
        if (previousConfig === undefined) delete process.env.SILLYTAVERN_IMAGE_CONFIG; else process.env.SILLYTAVERN_IMAGE_CONFIG = previousConfig;
        if (previousManaged === undefined) delete process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG; else process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = previousManaged;
        await rm(directory, { recursive: true, force: true });
    });
    const router = new FakeRouter();
    await init(router);
    return { router, calls: () => calls };
}

const user = handle => ({ profile: { handle, admin: false } });
const resolveRequest = (handle, regenerate) => ({
    method: 'POST', user: user(handle), body: {
        request: { text: 'a private cat', params: { profile: 'fixed', seed: 9 } },
        ...(regenerate === undefined ? {} : { regenerate }),
    },
});

test('resolve returns immutable JSON identity and exact retrieval is authenticated and user-scoped', async t => {
    const { router, calls } = await withPlugin(t);
    const resolve = router.route('POST', '/outputs/resolve');
    const retrieval = router.route('GET', '/outputs/:outputId');

    const first = await invoke(resolve, resolveRequest('alice'));
    const second = await invoke(resolve, resolveRequest('alice'));
    assert.equal(calls(), 1, 'ordinary resolution/reload reuses the output');
    assert.equal(first.body.outputId, second.body.outputId);
    assert.equal(first.body.requestKey, first.body.outputId);
    assert.match(first.body.outputUrl, new RegExp(first.body.outputId + '$'));
    assert.deepEqual(Object.keys(first.body.metadata).sort(), ['bytes', 'cached', 'createdAt', 'effectiveProfile', 'etag', 'fallbackReason', 'mime', 'requestedProfile', 'revisionOf'].sort());
    assert.equal(JSON.stringify(first.body).includes('a private cat'), false);

    // Exact lookup must not normalize against mutable provider state. Change the
    // selected profile type/model/workflow and routing before fetching by ID.
    await invoke(router.route('POST', '/providers/profile/save'), {
        method: 'POST', user: { profile: { handle: 'admin', admin: true } }, body: {
            profile: {
                name: 'fixed', type: 'comfyui', url: 'https://comfy.example.test',
                workflow: {
                    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'new-model.safetensors' } },
                    2: { class_type: 'Text', inputs: { text: 'changed workflow' } },
                    3: { class_type: 'SaveImage', inputs: {} },
                },
                bindings: { prompt: { node: '2', input: 'text' } }, outputNode: '3',
            },
        },
    });
    await invoke(router.route('POST', '/providers/routing'), {
        method: 'POST', user: { profile: { handle: 'admin', admin: true } },
        body: { enabled: true, fallbackProfile: 'fallback', fallbackOn: ['connection_error'] },
    });

    const exact = await invoke(retrieval, { method: 'GET', user: user('alice'), params: { outputId: first.body.outputId }, headers: {} });
    assert.equal(exact.statusCode, 200);
    assert.deepEqual(exact.body, Buffer.concat([PNG, Buffer.from([1])]));
    assert.match(exact.headers['Cache-Control'], /^private, .*immutable$/);

    await assert.rejects(
        invoke(retrieval, { method: 'GET', user: user('bob'), params: { outputId: first.body.outputId }, headers: {} }),
        error => error.status === 404 && error.code === 'output_not_found',
        'another authenticated user cannot retrieve Alice output even with its ID',
    );
    await assert.rejects(
        invoke(retrieval, { method: 'GET', params: { outputId: first.body.outputId }, headers: {} }),
        error => error.status === 401 && error.code === 'unauthorized',
    );
});

test('explicit same-request regeneration creates a distinct retrievable revision and missing IDs are 404', async t => {
    const { router, calls } = await withPlugin(t);
    const resolve = router.route('POST', '/resolve');
    const regenerate = router.route('POST', '/outputs/regenerate');
    const retrieval = router.route('GET', '/outputs/:outputId');

    const original = await invoke(resolve, {
        method: 'POST', user: user('alice'),
        body: { request: { prompt: 'a private cat', profile: 'fixed', seed: 9 } },
    });
    const revision = await invoke(regenerate, resolveRequest('alice'));
    assert.equal(calls(), 2);
    assert.notEqual(revision.body.outputId, original.body.outputId);
    assert.equal(revision.body.requestKey, original.body.requestKey);
    assert.equal(revision.body.metadata.revisionOf, original.body.requestKey);

    const oldBytes = await invoke(retrieval, { method: 'GET', user: user('alice'), params: { outputId: original.body.outputId }, headers: {} });
    const newBytes = await invoke(retrieval, { method: 'GET', user: user('alice'), params: { outputId: revision.body.outputId }, headers: {} });
    assert.deepEqual(oldBytes.body, Buffer.concat([PNG, Buffer.from([1])]));
    assert.deepEqual(newBytes.body, Buffer.concat([PNG, Buffer.from([2])]));

    const reload = await invoke(resolve, resolveRequest('alice'));
    assert.equal(reload.body.outputId, revision.body.outputId);
    assert.equal(calls(), 2, 'reload after regeneration reuses the current revision without generating');
    await assert.rejects(
        invoke(retrieval, { method: 'GET', user: user('alice'), params: { outputId: 'f'.repeat(64) }, headers: {} }),
        error => error.status === 404 && error.code === 'output_not_found',
    );
});

test('gallery listing is authenticated, user-scoped, chronological, paginated, and prompt-safe', async t => {
    const { router } = await withPlugin(t);
    const resolve = router.route('POST', '/outputs/resolve');
    const listing = router.route('GET', '/outputs');
    const thumbnail = router.route('GET', '/outputs/:outputId/thumbnail');
    const generated = [];
    for (const [prompt, seed] of [['first private prompt', 1], ['second private prompt', 2], ['third private prompt', 3]]) {
        generated.push((await invoke(resolve, {
            method: 'POST', user: user('alice'), body: { request: { prompt, profile: 'fixed', seed, width: 640, height: 480 } },
        })).body);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 2));
    }
    const bob = await invoke(resolve, {
        method: 'POST', user: user('bob'), body: { request: { prompt: 'bob secret', profile: 'fixed', seed: 4 } },
    });

    await assert.rejects(invoke(listing, { method: 'GET', query: {} }), error => error.status === 401 && error.code === 'unauthorized');
    const firstPage = await invoke(listing, { method: 'GET', user: user('alice'), query: { limit: '2' } });
    assert.deepEqual(firstPage.body.items.map(item => item.outputId), [generated[2].outputId, generated[1].outputId]);
    assert.ok(firstPage.body.nextCursor);
    assert.equal(JSON.stringify(firstPage.body).includes('private prompt'), false);
    assert.equal(Object.hasOwn(firstPage.body.items[0], 'promptHash'), false);
    assert.deepEqual(firstPage.body.items[0].request, { profile: 'fixed', width: 640, height: 480, seed: 3, model: 'old-model', enhance: false });
    assert.deepEqual(firstPage.body.items[0].thumbnail, { kind: 'original', resized: false });

    const secondPage = await invoke(listing, { method: 'GET', user: user('alice'), query: { limit: '2', cursor: firstPage.body.nextCursor } });
    assert.deepEqual(secondPage.body.items.map(item => item.outputId), [generated[0].outputId]);
    assert.equal(secondPage.body.nextCursor, null);
    assert.equal(firstPage.body.items.some(item => item.outputId === bob.body.outputId), false);
    const bobList = await invoke(listing, { method: 'GET', user: user('bob'), query: {} });
    assert.deepEqual(bobList.body.items.map(item => item.outputId), [bob.body.outputId]);
    await assert.rejects(invoke(listing, { method: 'GET', user: user('alice'), query: { cursor: 'not-a-cursor' } }), error => error.status === 400);
    await assert.rejects(invoke(listing, { method: 'GET', user: user('alice'), query: { cursor: 'eyJ2ZXJzaW9uIjoxLCJjcmVhdGVkQXQiOiJpbnZhbGlkIiwib3V0cHV0SWQiOiJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIn0' } }), error => error.status === 400);
    await assert.rejects(invoke(listing, { method: 'GET', user: user('alice'), query: { limit: '101' } }), error => error.status === 400);

    const thumb = await invoke(thumbnail, { method: 'GET', user: user('alice'), params: { outputId: generated[0].outputId }, headers: {} });
    assert.deepEqual(thumb.body, Buffer.concat([PNG, Buffer.from([1])]));
    assert.equal(thumb.headers['X-Thumbnail-Source'], 'original');
    assert.equal(thumb.headers['X-Thumbnail-Contract'], 'original-v1');
    await assert.rejects(
        invoke(thumbnail, { method: 'GET', user: user('bob'), params: { outputId: generated[0].outputId }, headers: {} }),
        error => error.status === 404 && error.code === 'output_not_found',
    );
});

test('chat references support scoped upsert, list, update, remove, and output ownership checks', async t => {
    const { router } = await withPlugin(t);
    const resolve = router.route('POST', '/outputs/resolve');
    const upsert = router.route('POST', '/references/upsert');
    const list = router.route('GET', '/references/:chatId');
    const listByBody = router.route('POST', '/references/list');
    const removeReference = router.route('POST', '/references/remove');
    const first = (await invoke(resolve, { method: 'POST', user: user('alice'), body: { request: { prompt: 'one', profile: 'fixed', seed: 11 } } })).body;
    const second = (await invoke(resolve, { method: 'POST', user: user('alice'), body: { request: { prompt: 'two', profile: 'fixed', seed: 12 } } })).body;
    const identity = { chatId: 'chat/one', messageId: '7', swipeKey: '2', slotId: 'portrait' };

    await assert.rejects(invoke(list, { method: 'GET', params: { chatId: 'chat/one' } }), error => error.status === 401);
    await assert.rejects(invoke(upsert, { method: 'POST', body: { ...identity, activeOutputId: first.outputId, historyIds: [first.outputId] } }), error => error.status === 401);
    await assert.rejects(invoke(removeReference, { method: 'POST', body: identity }), error => error.status === 401);
    const created = await invoke(upsert, {
        method: 'POST', user: user('alice'), body: { ...identity, activeOutputId: first.outputId, historyIds: [first.outputId] },
    });
    assert.equal(created.body.reference.schemaVersion, 1);
    assert.equal(created.body.reference.activeOutputId, first.outputId);
    const aliceList = await invoke(list, { method: 'GET', user: user('alice'), params: { chatId: 'chat/one' } });
    assert.equal(aliceList.body.references.length, 1);
    const bodyList = await invoke(listByBody, { method: 'POST', user: user('alice'), body: { chatId: 'chat/one' } });
    assert.deepEqual(bodyList.body.references, aliceList.body.references);
    assert.deepEqual(aliceList.body.references[0].historyIds, [first.outputId]);
    const bobList = await invoke(list, { method: 'GET', user: user('bob'), params: { chatId: 'chat/one' } });
    assert.deepEqual(bobList.body.references, []);

    await assert.rejects(
        invoke(upsert, { method: 'POST', user: user('bob'), body: { ...identity, activeOutputId: first.outputId, historyIds: [first.outputId] } }),
        error => error.status === 404 && error.code === 'output_not_found',
    );
    const updated = await invoke(upsert, {
        method: 'POST', user: user('alice'), body: { ...identity, activeOutputId: second.outputId, historyIds: [first.outputId, second.outputId] },
    });
    assert.equal(updated.body.reference.createdAt, created.body.reference.createdAt);
    assert.deepEqual(updated.body.reference.historyIds, [first.outputId, second.outputId]);

    const bobRemove = await invoke(removeReference, { method: 'POST', user: user('bob'), body: identity });
    assert.equal(bobRemove.body.removed, false);
    assert.equal((await invoke(list, { method: 'GET', user: user('alice'), params: { chatId: 'chat/one' } })).body.references.length, 1);
    const removed = await invoke(removeReference, { method: 'POST', user: user('alice'), body: identity });
    assert.equal(removed.body.removed, true);
    assert.deepEqual((await invoke(list, { method: 'GET', user: user('alice'), params: { chatId: 'chat/one' } })).body.references, []);

    await invoke(upsert, {
        method: 'POST', user: user('alice'), body: { ...identity, activeOutputId: first.outputId, historyIds: [first.outputId, second.outputId] },
    });
    await invoke(router.route('POST', '/outputs/clear'), { method: 'POST', user: user('alice'), body: { all: true } });
    assert.deepEqual((await invoke(list, { method: 'GET', user: user('alice'), params: { chatId: 'chat/one' } })).body.references, []);
});
