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
