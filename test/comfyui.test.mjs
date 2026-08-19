import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { comfyUiAdapter, ImageService, fingerprint } from '../core.mjs';
import { analyzeComfyWorkflow, validateComfyBindings, validateComfyWorkflow } from '../comfyui.mjs';
import { validateManagedProfile } from '../managed-config.mjs';
import { exit, init } from '../index.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const fixture = JSON.parse(await readFile(new URL('./fixtures/comfy-workflow.json', import.meta.url), 'utf8'));
const objectInfo = {
    PrimitiveString: { input: { required: { value: ['STRING', {}] } }, output: ['STRING'] },
    CLIPTextEncode: { input: { required: { text: ['STRING', {}], clip: ['CLIP', {}] } }, output: ['CONDITIONING'] },
    EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}] } }, output: ['LATENT'] },
    KSampler: { input: { required: { positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], seed: ['INT', {}] } }, output: ['LATENT'] },
    SaveImage: { input: { required: { images: ['IMAGE', {}] } }, output: [] },
    CLIPLoader: { input: { required: { clip_name: [['locked.safetensors'], {}] } }, output: ['CLIP'] },
    UNETLoader: { input: { required: { unet_name: [['locked.safetensors'], {}] } }, output: ['MODEL'] },
};
const bindings = {
    prompt: { node: '1', input: 'value' },
    negative: { node: '3', input: 'text' },
    seed: { node: '5', input: 'seed' },
    width: { node: '4', input: 'width' },
    height: { node: '4', input: 'height' },
};

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

test('Comfy workflow validation sanitizes API prompts and verifies binding targets', () => {
    const clean = validateComfyWorkflow(fixture);
    assert.notEqual(clean, fixture);
    assert.deepEqual(validateComfyBindings(bindings, clean), bindings);
    assert.throws(() => validateComfyBindings({ prompt: { node: '99', input: 'text' } }, clean), /does not exist/);
    assert.throws(() => validateComfyBindings({ prompt: { node: '1', input: 'missing' } }, clean), /does not exist/);
    assert.throws(() => validateComfyWorkflow({ 1: { class_type: 'X', inputs: { constructor: 'pollute' } } }), /unsafe/);
    assert.throws(() => validateComfyWorkflow({ 1: { class_type: 'X', inputs: {}, unexpected: true } }), /unsupported/);
});

test('managed Comfy profile stores workflow, strict bindings, output, and polling controls', () => {
    const clean = validateManagedProfile({
        type: 'comfyui', url: 'http://127.0.0.1:8188/', workflow: fixture, bindings,
        outputNode: 6, pollIntervalMs: 250, timeoutMs: 12_000, defaults: { width: 512, height: 512 },
    });
    assert.equal(clean.type, 'comfyui');
    assert.equal(clean.outputNode, '6');
    assert.equal(clean.pollIntervalMs, 250);
    assert.equal(clean.workflow['11'].inputs.unet_name, 'locked.safetensors');
    assert.throws(() => validateManagedProfile({ type: 'comfyui', url: 'http://localhost:8188', workflow: fixture, bindings: {} }), /prompt is required/);
    assert.throws(() => validateManagedProfile({ type: 'comfyui', url: 'http://localhost:8188', workflow: fixture, bindings, pollIntervalMs: 1 }), /50 to 60000/);
});

test('semantic analyzer follows CONDITIONING roles, linked strings, seed, dimensions, outputs, and missing classes', () => {
    const analysis = analyzeComfyWorkflow(validateComfyWorkflow(fixture), objectInfo);
    assert.equal(analysis.nodeCount, 9);
    assert.equal(analysis.candidates.prompt[0].binding.node, '1');
    assert.equal(analysis.candidates.prompt[0].binding.input, 'value');
    assert.equal(analysis.candidates.negative[0].binding.node, '3');
    assert.equal(analysis.candidates.seed[0].binding.node, '5');
    assert.equal(analysis.candidates.width[0].binding.node, '4');
    assert.equal(analysis.candidates.height[0].binding.node, '4');
    assert.equal(analysis.candidates.outputNode[0].node, '6');
    assert.deepEqual(analysis.missingClassTypes, ['VAEDecode']);
    assert.ok(analysis.candidates.prompt[0].path.some(step => step.node === '5' && step.input === 'positive'));
});

test('Comfy adapter clones and binds only configured inputs, polls, selects output, and downloads view bytes', async () => {
    const calls = [];
    let polls = 0;
    const profile = {
        type: 'comfyui', url: 'http://comfy.test/base/', workflow: validateComfyWorkflow(fixture), bindings,
        outputNode: '6', pollIntervalMs: 50, timeoutMs: 5000,
    };
    const result = await comfyUiAdapter(profile, {
        profile: 'local', prompt: 'new prompt', negative: 'new negative', seed: 7, width: 640, height: 480,
    }, {
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            const parsed = new URL(url);
            if (parsed.pathname === '/base/prompt') return Response.json({ prompt_id: 'abc' });
            if (parsed.pathname === '/base/history/abc') {
                polls++;
                return Response.json(polls === 1 ? {} : {
                    abc: { outputs: { 6: { images: [{ filename: 'out.png', subfolder: 'x', type: 'output' }] } } },
                });
            }
            if (parsed.pathname === '/base/view') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
            throw new Error(`unexpected URL ${url}`);
        },
    });
    assert.deepEqual(result.data, PNG);
    assert.equal(result.mime, 'image/png');
    const submitted = JSON.parse(calls[0].options.body).prompt;
    assert.equal(submitted['1'].inputs.value, 'new prompt');
    assert.equal(submitted['3'].inputs.text, 'new negative');
    assert.equal(submitted['5'].inputs.seed, 7);
    assert.equal(submitted['4'].inputs.width, 640);
    assert.equal(submitted['4'].inputs.height, 480);
    assert.equal(submitted['11'].inputs.unet_name, 'locked.safetensors', 'model inputs remain untouched');
    assert.equal(profile.workflow['1'].inputs.value, 'fixture prompt', 'stored workflow remains unchanged');
    assert.match(calls.at(-1).url, /\/base\/view\?filename=out.png&subfolder=x&type=output$/);
});

test('Comfy adapter enforces output node selection and image response limits', async () => {
    const profile = {
        type: 'comfyui', url: 'http://comfy.test', workflow: validateComfyWorkflow(fixture), bindings,
        outputNode: '6', pollIntervalMs: 50, timeoutMs: 5000,
    };
    await assert.rejects(comfyUiAdapter(profile, { prompt: 'x', negative: '', seed: null, width: 512, height: 512 }, {
        maxBytes: 8,
        fetchImpl: async url => {
            const pathname = new URL(url).pathname;
            if (pathname === '/prompt') return Response.json({ prompt_id: 'abc' });
            if (pathname === '/history/abc') return Response.json({ abc: { outputs: { 6: { images: [{ filename: 'x.png' }] } } } });
            return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
        },
    }), error => error.code === 'response_too_large');
});

test('provider routes return and save Comfy instruction prompts while analyze fetches only object_info', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'comfy-routes-'));
    const configPath = path.join(directory, 'config.yaml');
    const managedPath = path.join(directory, 'managed.json');
    const profile = {
        type: 'comfyui', url: 'http://comfy.test', workflow: fixture, bindings,
        instructionPrompt: 'Base Image Schema instructions may mention token fields without becoming secret.',
    };
    await writeFile(configPath, `defaultProfile: c\nprofiles:\n  c: ${JSON.stringify(profile)}\n`);
    const oldConfig = process.env.SILLYTAVERN_IMAGE_CONFIG;
    const oldManaged = process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG;
    const oldFetch = globalThis.fetch;
    process.env.SILLYTAVERN_IMAGE_CONFIG = configPath;
    process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = managedPath;
    let fetched;
    globalThis.fetch = async (url, options) => {
        fetched = { url: String(url), options };
        return Response.json(objectInfo);
    };
    t.after(async () => {
        await exit();
        globalThis.fetch = oldFetch;
        if (oldConfig === undefined) delete process.env.SILLYTAVERN_IMAGE_CONFIG; else process.env.SILLYTAVERN_IMAGE_CONFIG = oldConfig;
        if (oldManaged === undefined) delete process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG; else process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG = oldManaged;
        await rm(directory, { recursive: true, force: true });
    });
    const router = new FakeRouter();
    await init(router);
    const configResponse = responseCapture();
    router.route('GET', '/providers/config').handlers.at(-1)({ method: 'GET', user: { profile: { admin: true } } }, configResponse);
    assert.deepEqual(configResponse.body.profiles[0].workflow, fixture);
    assert.deepEqual(configResponse.body.profiles[0].bindings, bindings);
    assert.equal(configResponse.body.profiles[0].instructionPrompt, profile.instructionPrompt);

    const savedInstructionPrompt = 'Managed per-profile Image Schema instructions.';
    const saveRoute = router.route('POST', '/providers/profile/save');
    const saveResponse = responseCapture();
    await saveRoute.handlers.at(-1)({
        method: 'POST', user: { profile: { admin: true } },
        body: { profile: { name: 'c', ...profile, instructionPrompt: savedInstructionPrompt } },
    }, saveResponse, error => { throw error; });
    assert.deepEqual(saveResponse.body, { ok: true, name: 'c' });
    const openAiInstructionPrompt = 'OpenAI profile schema instructions.';
    const openAiSaveResponse = responseCapture();
    await saveRoute.handlers.at(-1)({
        method: 'POST', user: { profile: { admin: true } },
        body: { profile: { name: 'o', type: 'openai', url: 'https://openai.example.test/images', instructionPrompt: openAiInstructionPrompt } },
    }, openAiSaveResponse, error => { throw error; });
    assert.deepEqual(openAiSaveResponse.body, { ok: true, name: 'o' });
    const persisted = JSON.parse(await readFile(managedPath, 'utf8'));
    assert.equal(persisted.profiles.c.profile.instructionPrompt, savedInstructionPrompt);
    assert.equal(persisted.profiles.o.profile.instructionPrompt, openAiInstructionPrompt);

    const updatedConfigResponse = responseCapture();
    router.route('GET', '/providers/config').handlers.at(-1)({ method: 'GET', user: { profile: { admin: true } } }, updatedConfigResponse);
    assert.equal(updatedConfigResponse.body.profiles.find(item => item.name === 'c').instructionPrompt, savedInstructionPrompt);
    assert.equal(updatedConfigResponse.body.profiles.find(item => item.name === 'o').instructionPrompt, openAiInstructionPrompt);

    const route = router.route('POST', '/providers/comfy/analyze');
    const response = responseCapture();
    await route.handlers.at(-1)({ method: 'POST', body: { url: 'http://comfy.test/base', workflow: fixture }, user: { profile: { admin: true } } }, response, error => { throw error; });
    assert.equal(response.body.ok, true);
    assert.equal(response.body.analysis.candidates.outputNode[0].node, '6');
    assert.equal(fetched.url, 'http://comfy.test/base/object_info');
    assert.equal(fetched.options.method, 'GET');
});

test('Comfy workflow content and bindings participate in ImageService cache identity', () => {
    const profile = { type: 'comfyui', url: 'http://comfy.test', workflow: fixture, bindings, defaults: {} };
    const first = new ImageService({ defaultProfile: 'c', profiles: { c: profile } }, { cache: null });
    const changed = structuredClone(profile);
    changed.workflow['11'].inputs.unet_name = 'other-locked-model.safetensors';
    const second = new ImageService({ defaultProfile: 'c', profiles: { c: changed } }, { cache: null });
    const bindingChanged = structuredClone(profile);
    bindingChanged.bindings.prompt = { node: '3', input: 'text' };
    const third = new ImageService({ defaultProfile: 'c', profiles: { c: bindingChanged } }, { cache: null });
    assert.notEqual(first.prepare({ prompt: 'cat' }).key, second.prepare({ prompt: 'cat' }).key);
    assert.notEqual(first.prepare({ prompt: 'cat' }).key, third.prepare({ prompt: 'cat' }).key);
    assert.notEqual(fingerprint(profile.workflow), fingerprint(changed.workflow));
});
