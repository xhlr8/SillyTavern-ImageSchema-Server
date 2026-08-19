import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ImageService } from '../core.mjs';
import {
    ManagedProfileStore,
    mergeManagedConfig,
    validateManagedProfile,
    validateSecret,
} from '../managed-config.mjs';

const baseConfig = () => ({
    defaultProfile: 'base',
    cache: { enabled: false, perUser: true },
    profiles: {
        base: {
            type: 'openai',
            url: 'https://base.example.test/images',
            apiKey: 'base-secret',
            model: 'base-model',
            instructionPrompt: 'Use the saved schema instructions for this profile.',
            defaults: { width: 1024, height: 1024 },
        },
        other: { type: 'generic', method: 'GET', url: 'https://other.example.test/{prompt}', defaults: {} },
    },
});

async function fixture(t, onChange = async () => {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-image-profiles-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'managed-config.json');
    const store = new ManagedProfileStore({ baseConfig: baseConfig(), filePath, onChange });
    await store.load();
    return { store, filePath, directory };
}

test('managed profile schemas reject extra, sensitive, and unsafe method fields', () => {
    assert.throws(() => validateManagedProfile({ type: 'openai', url: 'https://example.test', arbitrary: true }), /unsupported field/);
    assert.throws(() => validateManagedProfile({ type: 'generic', url: 'https://example.test', method: 'DELETE' }), /GET or POST/);
    assert.throws(() => validateManagedProfile({ type: 'generic', url: 'https://example.test', headers: { Authorization: 'secret' } }), /must not contain credentials/);
    assert.throws(() => validateManagedProfile({ type: 'openai', url: 'https://u:p@example.test' }), /without embedded credentials/);
    assert.throws(() => validateSecret('openai', { apiKey: 'x', extra: 'y' }), /unsupported field/);
    assert.throws(() => validateSecret('generic', { headerName: 'Host', value: 'evil' }), /not allowed/);
});

test('instructionPrompt is accepted for every managed profile type with a strict length limit', () => {
    const prompt = 'Describe the image using the profile schema.';
    const profiles = [
        { type: 'openai', url: 'https://openai.example.test/images' },
        { type: 'gemini-sse', url: 'https://gemini.example.test/generate' },
        { type: 'generic', url: 'https://generic.example.test/image' },
        {
            type: 'comfyui', url: 'https://comfy.example.test',
            workflow: { 1: { class_type: 'Prompt', inputs: { text: '' } } },
            bindings: { prompt: { node: '1', input: 'text' } },
        },
    ];
    for (const profile of profiles) {
        assert.equal(validateManagedProfile({ ...profile, instructionPrompt: prompt }).instructionPrompt, prompt);
        assert.throws(() => validateManagedProfile({ ...profile, instructionPrompt: 42 }), /instructionPrompt must be a string/);
        assert.throws(() => validateManagedProfile({ ...profile, instructionPrompt: 'x'.repeat(20_001) }), /instructionPrompt must be a string/);
    }
});

test('store persists atomically, protects the file, exposes instructions, and never exposes secret values', async t => {
    const { store, filePath, directory } = await fixture(t);
    const secret = 'managed-super-secret';
    const instructionPrompt = 'Return a concise Image Schema object.';
    await store.create('managed', { type: 'openai', url: 'https://managed.example.test/images', model: 'm', instructionPrompt });
    const view = await store.replaceSecret('managed', { apiKey: secret });

    assert.equal(view.profiles.managed.hasSecret, true);
    assert.equal(view.profiles.managed.instructionPrompt, instructionPrompt);
    assert.equal(view.profiles.base.instructionPrompt, 'Use the saved schema instructions for this profile.');
    assert.equal(JSON.stringify(view).includes(secret), false);
    assert.equal(JSON.stringify(view).includes('apiKey'), false);
    const persisted = await readFile(filePath, 'utf8');
    assert.equal(persisted.includes(secret), true);
    assert.equal(JSON.parse(persisted).profiles.managed.profile.instructionPrompt, instructionPrompt);
    assert.deepEqual(await readdir(directory), ['managed-config.json']);
    if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('managed merge precedence overrides, tombstones, and default selection predictably', async t => {
    const { store } = await fixture(t);
    await store.update('base', { type: 'openai', url: 'https://override.example.test/images', model: 'override' });
    assert.equal(store.config.profiles.base.url, 'https://override.example.test/images');
    assert.equal(store.config.profiles.base.apiKey, 'base-secret', 'base secret is inherited until explicitly deleted');

    await store.deleteSecret('base');
    assert.equal(store.config.profiles.base.apiKey, undefined);
    await store.setDefault('other');
    await store.delete('base');
    assert.equal(store.config.profiles.base, undefined);
    assert.equal(store.config.defaultProfile, 'other');
    assert.deepEqual(store.view().deletedBaseProfiles, ['base']);

    const merged = mergeManagedConfig(baseConfig(), {
        version: 1,
        defaultProfile: 'missing',
        profiles: { added: { profile: { type: 'generic', method: 'GET', url: 'https://added.example.test' } } },
        deletedProfiles: ['base'],
    });
    assert.equal(merged.defaultProfile, 'other');
    assert.deepEqual(Object.keys(merged.profiles), ['other', 'added']);
});

test('save treats a stale previousName as an upsert', async t => {
    const { store } = await fixture(t);
    await store.save('new-profile', { type: 'generic', url: 'https://new.example.test', method: 'GET' }, 'missing-old-name');
    assert.equal(store.config.profiles['new-profile'].url, 'https://new.example.test');
});

test('save supports atomic extension-contract rename and retains matching managed secret', async t => {
    const { store } = await fixture(t);
    await store.create('old', { type: 'openai', url: 'https://old.example.test', model: 'old' });
    await store.replaceSecret('old', { apiKey: 'rename-secret' });
    await store.setDefault('old');
    const view = await store.save('new', { type: 'openai', url: 'https://new.example.test', model: 'new' }, 'old');
    assert.equal(store.config.profiles.old, undefined);
    assert.equal(store.config.profiles.new.apiKey, 'rename-secret');
    assert.equal(store.config.defaultProfile, 'new');
    assert.equal(JSON.stringify(view).includes('rename-secret'), false);
});

test('failed mutation neither changes live config nor replaces persisted document', async t => {
    const { store, filePath } = await fixture(t);
    await store.create('ok', { type: 'generic', method: 'GET', url: 'https://ok.example.test' });
    const before = await readFile(filePath, 'utf8');
    await assert.rejects(store.update('ok', { type: 'generic', method: 'PATCH', url: 'https://bad.example.test' }), /GET or POST/);
    assert.equal(await readFile(filePath, 'utf8'), before);
    assert.equal(store.config.profiles.ok.url, 'https://ok.example.test');
});

test('store load rejects malformed managed config without disclosing its contents', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-image-invalid-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'managed-config.json');
    await writeFile(filePath, '{"secret":"do-not-echo"');
    const store = new ManagedProfileStore({ baseConfig: baseConfig(), filePath });
    await assert.rejects(store.load(), error => {
        assert.equal(error.message.includes('do-not-echo'), false);
        return /Could not parse/.test(error.message);
    });
});

test('config changes update existing ImageService instances without replacing them', async t => {
    let service;
    const { store } = await fixture(t, config => service.setConfig(config));
    service = new ImageService(store.config, { cache: null, fetchImpl: async () => { throw new Error('unused'); } });
    assert.equal(service.prepare({ profile: 'base', prompt: 'before' }).profile.url, 'https://base.example.test/images');
    await store.update('base', { type: 'openai', url: 'https://live.example.test/images', model: 'live' });
    assert.equal(service.prepare({ profile: 'base', prompt: 'after' }).profile.url, 'https://live.example.test/images');
    assert.throws(() => service.prepare({ profile: 'missing', prompt: 'x' }), /Unknown profile/);
});

test('deleting the final effective profile is rejected', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-image-last-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'managed-config.json');
    const store = new ManagedProfileStore({
        baseConfig: { defaultProfile: 'only', profiles: { only: { type: 'generic', method: 'GET', url: 'https://only.example.test' } } },
        filePath,
    });
    await store.load();
    await assert.rejects(store.delete('only'), /At least one effective profile/);
    await assert.rejects(access(filePath));
    assert.ok(store.config.profiles.only);
});
