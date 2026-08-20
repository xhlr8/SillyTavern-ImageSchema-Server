import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { INSTRUCTION_PROMPT_MAX_LENGTH, PluginError, profilePublicView, validateConfig } from './core.mjs';
import { validateComfyBindings, validateComfyWorkflow } from './comfyui.mjs';

const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|password|credential/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UNSAFE_SECRET_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-authenticate']);
const COMMON_FIELDS = new Set(['type', 'url', 'model', 'allowedModels', 'timeoutMs', 'defaults', 'headers', 'instructionPrompt']);
const TYPE_FIELDS = {
    openai: new Set([...COMMON_FIELDS, 'body']),
    'gemini-sse': new Set([...COMMON_FIELDS, 'queryApiKey', 'systemInstruction', 'generationConfig', 'imageConfig']),
    generic: new Set([...COMMON_FIELDS, 'method', 'query', 'body', 'responseImagePath', 'responseMimePath', 'responseEncoding']),
    comfyui: new Set(['type', 'url', 'workflow', 'bindings', 'outputNode', 'pollIntervalMs', 'timeoutMs', 'defaults', 'instructionPrompt']),
};
const DEFAULT_FIELDS = new Set(['width', 'height', 'negative', 'model', 'quality', 'outputFormat', 'background', 'enhance', 'aspectRatio', 'imageSize', 'temperature', 'personGeneration']);
export const DEFAULT_FALLBACK_ON = Object.freeze(['connection_error', 'timeout', 'rate_limit', 'upstream_error', 'invalid_upstream_response', 'response_too_large']);
export const ALLOWED_FALLBACK_ON = Object.freeze([...DEFAULT_FALLBACK_ON, 'safety', 'invalid_request', 'config_error']);
const FALLBACK_CODE_SET = new Set(ALLOWED_FALLBACK_ON);

function invalid(message) {
    return new PluginError(message, { status: 400, code: 'invalid_config' });
}

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw invalid(`${label} must be an object`);
    }
    return value;
}

function exactFields(value, allowed, label) {
    plainObject(value, label);
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) throw invalid(`${label} contains unsupported field: ${key}`);
    }
}

function safeJson(value, label, depth = 0) {
    if (depth > 8) throw invalid(`${label} is too deeply nested`);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.length > 100_000) throw invalid(`${label} contains an overlong string`);
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalid(`${label} contains a non-finite number`);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 1_000) throw invalid(`${label} contains too many items`);
        return value.map((item, index) => safeJson(item, `${label}[${index}]`, depth + 1));
    }
    plainObject(value, label);
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw invalid(`${label} contains too many fields`);
    const result = {};
    for (const [key, item] of entries) {
        if (FORBIDDEN_KEYS.has(key)) throw invalid(`${label} contains an unsafe field`);
        if (SENSITIVE_KEY.test(key)) throw invalid(`${label} must not contain credentials; use the secret route`);
        result[key] = safeJson(item, `${label}.${key}`, depth + 1);
    }
    return result;
}

function optionalString(value, label, { nonempty = false, max = 100_000 } = {}) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) throw invalid(`${label} must be ${nonempty ? 'a non-empty ' : 'a '}string`);
    return value;
}

function validateUrl(value, label) {
    if (typeof value !== 'string' || value.length > 8_192) throw invalid(`${label} must be a URL string`);
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe URL');
    } catch {
        throw invalid(`${label} must be an HTTP(S) URL without embedded credentials`);
    }
    return value;
}

function validateDefaults(value, label) {
    if (value === undefined) return undefined;
    exactFields(value, DEFAULT_FIELDS, label);
    return safeJson(value, label);
}

export function validateManagedProfile(input, name = 'profile') {
    plainObject(input, name);
    const type = input.type;
    const allowed = TYPE_FIELDS[type];
    if (!allowed) throw invalid(`${name}.type must be openai, gemini-sse, generic, or comfyui`);
    exactFields(input, allowed, name);
    const result = { type, url: validateUrl(input.url, `${name}.url`) };
    if (input.headers !== undefined) result.headers = safeJson(input.headers, `${name}.headers`);
    if (input.model !== undefined) result.model = optionalString(input.model, `${name}.model`, { max: 500 });
    if (input.instructionPrompt !== undefined) result.instructionPrompt = optionalString(input.instructionPrompt, `${name}.instructionPrompt`, { max: INSTRUCTION_PROMPT_MAX_LENGTH });
    if (input.allowedModels !== undefined) {
        if (!Array.isArray(input.allowedModels) || input.allowedModels.length > 100 || input.allowedModels.some(item => typeof item !== 'string' || !item || item.length > 500)) {
            throw invalid(`${name}.allowedModels must be an array of non-empty strings`);
        }
        result.allowedModels = [...new Set(input.allowedModels)];
    }
    if (input.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 900_000) throw invalid(`${name}.timeoutMs must be an integer from 1000 to 900000`);
        result.timeoutMs = input.timeoutMs;
    }
    const defaults = validateDefaults(input.defaults, `${name}.defaults`);
    if (defaults !== undefined) result.defaults = defaults;

    if (type === 'openai' && input.body !== undefined) result.body = safeJson(input.body, `${name}.body`);
    if (type === 'gemini-sse') {
        if (input.queryApiKey !== undefined) {
            if (typeof input.queryApiKey !== 'boolean') throw invalid(`${name}.queryApiKey must be boolean`);
            result.queryApiKey = input.queryApiKey;
        }
        if (input.systemInstruction !== undefined) result.systemInstruction = optionalString(input.systemInstruction, `${name}.systemInstruction`);
        if (input.generationConfig !== undefined) result.generationConfig = safeJson(input.generationConfig, `${name}.generationConfig`);
        if (input.imageConfig !== undefined) result.imageConfig = safeJson(input.imageConfig, `${name}.imageConfig`);
    }
    if (type === 'comfyui') {
        const workflow = validateComfyWorkflow(input.workflow, `${name}.workflow`, invalid);
        result.workflow = workflow;
        result.bindings = validateComfyBindings(input.bindings, workflow, `${name}.bindings`, invalid);
        if (input.outputNode !== undefined) {
            const outputNode = String(input.outputNode);
            if (!outputNode || outputNode.length > 200 || !Object.hasOwn(workflow, outputNode)) throw invalid(`${name}.outputNode must identify a workflow node`);
            result.outputNode = outputNode;
        }
        if (input.pollIntervalMs !== undefined) {
            if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 50 || input.pollIntervalMs > 60_000) throw invalid(`${name}.pollIntervalMs must be an integer from 50 to 60000`);
            result.pollIntervalMs = input.pollIntervalMs;
        }
    }
    if (type === 'generic') {
        const method = String(input.method ?? 'GET').toUpperCase();
        if (!['GET', 'POST'].includes(method)) throw invalid(`${name}.method must be GET or POST`);
        result.method = method;
        if (input.query !== undefined) result.query = safeJson(input.query, `${name}.query`);
        if (input.body !== undefined) result.body = safeJson(input.body, `${name}.body`);
        if (input.responseImagePath !== undefined) result.responseImagePath = optionalString(input.responseImagePath, `${name}.responseImagePath`, { nonempty: true, max: 1_000 });
        if (input.responseMimePath !== undefined) result.responseMimePath = optionalString(input.responseMimePath, `${name}.responseMimePath`, { nonempty: true, max: 1_000 });
        if (input.responseEncoding !== undefined) {
            if (!['base64', 'url'].includes(input.responseEncoding)) throw invalid(`${name}.responseEncoding must be base64 or url`);
            result.responseEncoding = input.responseEncoding;
        }
    }
    return result;
}

export function validateProfileName(name) {
    if (typeof name !== 'string' || !PROFILE_NAME.test(name) || name.length > 100) throw invalid('Invalid profile name');
    return name;
}

export function validateRoutingSettings(input, label = 'routing') {
    exactFields(input, new Set(['enabled', 'fallbackProfile', 'fallbackOn']), label);
    if (typeof input.enabled !== 'boolean') throw invalid(`${label}.enabled must be boolean`);
    let fallbackProfile = null;
    if (input.fallbackProfile !== undefined && input.fallbackProfile !== null && input.fallbackProfile !== '') {
        fallbackProfile = validateProfileName(input.fallbackProfile);
    }
    if (!Array.isArray(input.fallbackOn) || input.fallbackOn.length > ALLOWED_FALLBACK_ON.length) {
        throw invalid(`${label}.fallbackOn must be an array of supported failure codes`);
    }
    const fallbackOn = [];
    for (const code of input.fallbackOn) {
        if (typeof code !== 'string' || !FALLBACK_CODE_SET.has(code)) throw invalid(`${label}.fallbackOn contains unsupported code: ${code}`);
        if (!fallbackOn.includes(code)) fallbackOn.push(code);
    }
    return { enabled: input.enabled, fallbackProfile, fallbackOn };
}

function defaultRoutingSettings() {
    return { enabled: false, fallbackProfile: null, fallbackOn: [...DEFAULT_FALLBACK_ON] };
}

export function validateSecret(type, input) {
    if (type === 'openai' || type === 'gemini-sse') {
        exactFields(input, new Set(['apiKey']), 'secret');
        const apiKey = optionalString(input.apiKey, 'secret.apiKey', { nonempty: true, max: 20_000 });
        return { apiKey };
    }
    if (type === 'generic') {
        exactFields(input, new Set(['headerName', 'value']), 'secret');
        const headerName = optionalString(input.headerName, 'secret.headerName', { nonempty: true, max: 200 });
        const value = optionalString(input.value, 'secret.value', { nonempty: true, max: 20_000 });
        if (!HTTP_HEADER_NAME.test(headerName) || UNSAFE_SECRET_HEADERS.has(headerName.toLowerCase())) throw invalid('secret.headerName is not allowed');
        if (/\r|\n/.test(value)) throw invalid('secret.value must not contain line breaks');
        return { headerName, value };
    }
    throw invalid('Unsupported profile type');
}

function blankDocument() {
    return { version: 1, defaultProfile: null, routing: defaultRoutingSettings(), profiles: {}, deletedProfiles: [] };
}

function validateDocument(value) {
    exactFields(value, new Set(['version', 'defaultProfile', 'routing', 'profiles', 'deletedProfiles']), 'managed config');
    if (value.version !== 1) throw invalid('managed config.version must be 1');
    const routing = value.routing === undefined ? defaultRoutingSettings() : validateRoutingSettings(value.routing, 'managed config.routing');
    if (value.defaultProfile !== null) validateProfileName(value.defaultProfile);
    plainObject(value.profiles, 'managed config.profiles');
    const profiles = {};
    for (const [name, entry] of Object.entries(value.profiles)) {
        validateProfileName(name);
        exactFields(entry, new Set(['profile', 'secret', 'secretDeleted']), `managed profile ${name}`);
        const profile = validateManagedProfile(entry.profile, `managed profile ${name}.profile`);
        const clean = { profile };
        if (entry.secret !== undefined) clean.secret = validateSecret(profile.type, entry.secret);
        if (entry.secretDeleted !== undefined) {
            if (entry.secretDeleted !== true) throw invalid(`managed profile ${name}.secretDeleted must be true`);
            clean.secretDeleted = true;
        }
        if (clean.secret && clean.secretDeleted) throw invalid(`managed profile ${name} has conflicting secret state`);
        profiles[name] = clean;
    }
    if (!Array.isArray(value.deletedProfiles)) throw invalid('managed config.deletedProfiles must be an array');
    const deletedProfiles = [...new Set(value.deletedProfiles.map(validateProfileName))];
    for (const name of Object.keys(profiles)) {
        if (deletedProfiles.includes(name)) throw invalid(`managed profile ${name} is also deleted`);
    }
    return { version: 1, defaultProfile: value.defaultProfile, routing, profiles, deletedProfiles };
}

function sensitiveHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    return Object.fromEntries(Object.entries(headers).filter(([name]) => SENSITIVE_KEY.test(name)));
}

function applySecret(profile, entry, baseProfile) {
    const merged = structuredClone(profile);
    if (!entry.secretDeleted && !entry.secret && baseProfile?.type === profile.type) {
        if (baseProfile.apiKey) merged.apiKey = baseProfile.apiKey;
        const inheritedHeaders = sensitiveHeaders(baseProfile.headers);
        if (Object.keys(inheritedHeaders).length) merged.headers = { ...(merged.headers ?? {}), ...inheritedHeaders };
    }
    if (entry.secret?.apiKey) merged.apiKey = entry.secret.apiKey;
    if (entry.secret?.headerName) merged.headers = { ...(merged.headers ?? {}), [entry.secret.headerName]: entry.secret.value };
    return merged;
}

export function mergeManagedConfig(baseConfig, document) {
    const managed = validateDocument(structuredClone(document));
    const profiles = {};
    const deleted = new Set(managed.deletedProfiles);
    for (const [name, profile] of Object.entries(baseConfig.profiles)) {
        if (!deleted.has(name) && !managed.profiles[name]) profiles[name] = structuredClone(profile);
    }
    for (const [name, entry] of Object.entries(managed.profiles)) {
        profiles[name] = applySecret(entry.profile, entry, baseConfig.profiles[name]);
    }
    if (!Object.keys(profiles).length) throw invalid('At least one effective profile is required');
    const preferred = managed.defaultProfile ?? baseConfig.defaultProfile;
    const defaultProfile = profiles[preferred] ? preferred : Object.keys(profiles)[0];
    const routing = {
        ...managed.routing,
        fallbackProfile: managed.routing.fallbackProfile && profiles[managed.routing.fallbackProfile] ? managed.routing.fallbackProfile : null,
    };
    return validateConfig({ ...structuredClone(baseConfig), defaultProfile, routing, profiles });
}

function stripSecrets(value, depth = 0, { hideAllHeaders = false } = {}) {
    if (depth > 10 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => stripSecrets(item, depth + 1, { hideAllHeaders }));
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        // ComfyUI workflows are validated server-side plain JSON and intentionally
        // returned for UI editing. Node/input names that happen to contain words
        // such as "token" are workflow semantics, not provider credentials.
        if (key === 'workflow' && item && typeof item === 'object' && !Array.isArray(item)) {
            result.workflow = structuredClone(item);
            continue;
        }
        if (SENSITIVE_KEY.test(key)) continue;
        if (key === 'headers' && item && typeof item === 'object' && !Array.isArray(item)) {
            if (hideAllHeaders) {
                result.headerNames = Object.keys(item);
            } else {
                const headers = Object.fromEntries(Object.entries(item).filter(([name]) => !SENSITIVE_KEY.test(name)));
                if (Object.keys(headers).length) result.headers = stripSecrets(headers, depth + 1, { hideAllHeaders });
            }
            continue;
        }
        result[key] = stripSecrets(item, depth + 1, { hideAllHeaders });
    }
    return result;
}

function effectiveHasSecret(profile) {
    return Boolean(profile.apiKey || Object.keys(sensitiveHeaders(profile.headers)).length);
}

export function managedConfigPublicView(baseConfig, document, effectiveConfig = mergeManagedConfig(baseConfig, document)) {
    const profiles = {};
    const deleted = new Set(document.deletedProfiles);
    for (const [name, profile] of Object.entries(effectiveConfig.profiles)) {
        profiles[name] = {
            ...stripSecrets(profile, 0, { hideAllHeaders: true }),
            name,
            default: name === effectiveConfig.defaultProfile,
            source: document.profiles[name] ? (baseConfig.profiles[name] ? 'managed-override' : 'managed') : 'base',
            hasSecret: effectiveHasSecret(profile),
        };
    }
    return {
        defaultProfile: effectiveConfig.defaultProfile,
        routing: structuredClone(effectiveConfig.routing),
        profiles,
        deletedBaseProfiles: [...deleted].filter(name => Boolean(baseConfig.profiles[name])),
    };
}

export function profilesPublicView(config) {
    return {
        defaultProfile: config.defaultProfile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => profilePublicView(name, profile, name === config.defaultProfile)),
    };
}

async function atomicWrite(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(tempPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await chmod(tempPath, 0o600).catch(error => {
            if (process.platform !== 'win32') throw error;
        });
        await rename(tempPath, filePath);
        await chmod(filePath, 0o600).catch(error => {
            if (process.platform !== 'win32') throw error;
        });
    } finally {
        if (handle) await handle.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

export class ManagedProfileStore {
    constructor({ baseConfig, filePath, onChange = async () => {} }) {
        this.baseConfig = validateConfig(structuredClone(baseConfig));
        this.filePath = filePath;
        this.onChange = onChange;
        this.document = blankDocument();
        this.config = this.baseConfig;
        this.queue = Promise.resolve();
    }

    async load() {
        let parsed;
        try {
            parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
            await chmod(this.filePath, 0o600).catch(error => {
                if (process.platform !== 'win32') throw error;
            });
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                if (error instanceof SyntaxError) throw new PluginError('Could not parse managed profile config', { status: 500, code: 'config_error', cause: error });
                throw error;
            }
            parsed = blankDocument();
        }
        try {
            this.document = validateDocument(parsed);
            this.config = mergeManagedConfig(this.baseConfig, this.document);
        } catch (error) {
            if (error instanceof PluginError) throw new PluginError(`Invalid managed profile config: ${error.message}`, { status: 500, code: 'config_error', cause: error });
            throw error;
        }
        return this.config;
    }

    view() {
        return managedConfigPublicView(this.baseConfig, this.document, this.config);
    }

    mutate(operation) {
        const run = this.queue.then(async () => {
            const next = structuredClone(this.document);
            await operation(next);
            const clean = validateDocument(next);
            const config = mergeManagedConfig(this.baseConfig, clean);
            await atomicWrite(this.filePath, clean);
            this.document = clean;
            this.config = config;
            await this.onChange(config);
            return this.view();
        });
        this.queue = run.catch(() => {});
        return run;
    }

    create(name, profile) {
        validateProfileName(name);
        return this.mutate(next => {
            if (this.config.profiles[name] || next.profiles[name]) throw new PluginError(`Profile already exists: ${name}`, { status: 409, code: 'profile_exists' });
            next.deletedProfiles = next.deletedProfiles.filter(item => item !== name);
            next.profiles[name] = { profile: validateManagedProfile(profile, 'profile') };
        });
    }

    save(name, profile, previousName = name) {
        validateProfileName(name);
        validateProfileName(previousName);
        if (previousName === name) return this.config.profiles[name] ? this.update(name, profile) : this.create(name, profile);
        // A client may retain a previousName after an earlier failed create or a
        // plugin restart. Treat that stale rename hint as an upsert of `name`.
        if (!this.config.profiles[previousName]) return this.config.profiles[name] ? this.update(name, profile) : this.create(name, profile);
        return this.mutate(next => {
            if (!this.config.profiles[previousName]) throw new PluginError(`Unknown profile: ${previousName}`, { status: 404, code: 'invalid_profile' });
            if (this.config.profiles[name]) throw new PluginError(`Profile already exists: ${name}`, { status: 409, code: 'profile_exists' });
            const cleanProfile = validateManagedProfile(profile, 'profile');
            const previous = next.profiles[previousName];
            const entry = { profile: cleanProfile };
            if (previous?.profile.type === cleanProfile.type) {
                if (previous.secret) entry.secret = previous.secret;
                if (previous.secretDeleted) entry.secretDeleted = true;
            }
            delete next.profiles[previousName];
            next.profiles[name] = entry;
            next.deletedProfiles = next.deletedProfiles.filter(item => item !== name);
            if (this.baseConfig.profiles[previousName]) next.deletedProfiles.push(previousName);
            if (next.defaultProfile === previousName || (next.defaultProfile === null && this.baseConfig.defaultProfile === previousName)) next.defaultProfile = name;
            if (next.routing.fallbackProfile === previousName) next.routing.fallbackProfile = name;
        });
    }

    update(name, profile) {
        validateProfileName(name);
        return this.mutate(next => {
            if (!this.config.profiles[name]) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            const previous = next.profiles[name];
            const cleanProfile = validateManagedProfile(profile, 'profile');
            const entry = { profile: cleanProfile };
            if (previous?.profile.type === cleanProfile.type) {
                if (previous.secret) entry.secret = previous.secret;
                if (previous.secretDeleted) entry.secretDeleted = true;
            }
            next.deletedProfiles = next.deletedProfiles.filter(item => item !== name);
            next.profiles[name] = entry;
        });
    }

    delete(name) {
        validateProfileName(name);
        return this.mutate(next => {
            if (!this.config.profiles[name]) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            delete next.profiles[name];
            if (this.baseConfig.profiles[name]) next.deletedProfiles.push(name);
            const remaining = Object.keys(this.config.profiles).filter(item => item !== name);
            if (!remaining.length) throw invalid('At least one effective profile is required');
            if (next.defaultProfile === name || (next.defaultProfile === null && this.baseConfig.defaultProfile === name)) next.defaultProfile = remaining[0];
            if (next.routing.fallbackProfile === name) {
                next.routing.fallbackProfile = null;
                next.routing.enabled = false;
            }
        });
    }

    setDefault(name) {
        validateProfileName(name);
        return this.mutate(next => {
            if (!this.config.profiles[name]) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            next.defaultProfile = name;
        });
    }

    setRouting(settings) {
        const clean = validateRoutingSettings(settings);
        return this.mutate(next => {
            if (clean.fallbackProfile && !this.config.profiles[clean.fallbackProfile]) {
                throw new PluginError(`Unknown fallback profile: ${clean.fallbackProfile}`, { status: 400, code: 'invalid_config' });
            }
            if (clean.enabled && !clean.fallbackProfile) throw invalid('routing.fallbackProfile is required when routing is enabled');
            next.routing = clean;
        });
    }

    replaceSecret(name, secret) {
        validateProfileName(name);
        return this.mutate(next => {
            const effective = this.config.profiles[name];
            if (!effective) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            if (!next.profiles[name]) next.profiles[name] = { profile: validateManagedProfile(stripSecrets(effective), 'profile') };
            next.profiles[name].secret = validateSecret(effective.type, secret);
            delete next.profiles[name].secretDeleted;
            next.deletedProfiles = next.deletedProfiles.filter(item => item !== name);
        });
    }

    deleteSecret(name) {
        validateProfileName(name);
        return this.mutate(next => {
            const effective = this.config.profiles[name];
            if (!effective) throw new PluginError(`Unknown profile: ${name}`, { status: 404, code: 'invalid_profile' });
            if (!next.profiles[name]) next.profiles[name] = { profile: validateManagedProfile(stripSecrets(effective), 'profile') };
            delete next.profiles[name].secret;
            next.profiles[name].secretDeleted = true;
        });
    }
}
