const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const comfyWorkflowLimits = Object.freeze({
    maxBytes: 4 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 2_000,
    maxEntries: 100_000,
    maxArrayLength: 10_000,
    maxStringLength: 1_000_000,
});

function defaultInvalid(message) {
    return new TypeError(message);
}

function fail(invalid, message) {
    throw invalid(message);
}

export function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeKey(key, label, invalid) {
    if (FORBIDDEN_KEYS.has(key)) fail(invalid, `${label} contains an unsafe field`);
    if (key.length > 500) fail(invalid, `${label} contains an overlong field name`);
}

function cloneJson(value, label, state, depth) {
    if (depth > state.limits.maxDepth) fail(state.invalid, `${label} is too deeply nested`);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.length > state.limits.maxStringLength) fail(state.invalid, `${label} contains an overlong string`);
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail(state.invalid, `${label} contains a non-finite number`);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > state.limits.maxArrayLength) fail(state.invalid, `${label} contains too many items`);
        state.entries += value.length;
        if (state.entries > state.limits.maxEntries) fail(state.invalid, `${label} is too large`);
        return value.map((item, index) => cloneJson(item, `${label}[${index}]`, state, depth + 1));
    }
    if (!isPlainObject(value)) fail(state.invalid, `${label} must contain only plain JSON objects`);
    const entries = Object.entries(value);
    state.entries += entries.length;
    if (state.entries > state.limits.maxEntries) fail(state.invalid, `${label} is too large`);
    const result = {};
    for (const [key, item] of entries) {
        safeKey(key, label, state.invalid);
        result[key] = cloneJson(item, `${label}.${key}`, state, depth + 1);
    }
    return result;
}

/**
 * Strictly validates and clones a ComfyUI API-format prompt. The returned value
 * contains no inherited/custom-prototype objects and no prototype-pollution keys.
 */
export function validateComfyWorkflow(value, label = 'workflow', invalid = defaultInvalid, limits = comfyWorkflowLimits) {
    if (!isPlainObject(value)) fail(invalid, `${label} must be a plain object`);
    const nodeEntries = Object.entries(value);
    if (!nodeEntries.length) fail(invalid, `${label} must contain at least one node`);
    if (nodeEntries.length > limits.maxNodes) fail(invalid, `${label} contains too many nodes (maximum ${limits.maxNodes})`);

    let serialized;
    try { serialized = JSON.stringify(value); } catch { fail(invalid, `${label} must be JSON serializable`); }
    if (Buffer.byteLength(serialized, 'utf8') > limits.maxBytes) fail(invalid, `${label} exceeds the ${limits.maxBytes} byte limit`);

    const state = { invalid, limits, entries: nodeEntries.length };
    const workflow = {};
    for (const [nodeId, rawNode] of nodeEntries) {
        safeKey(nodeId, label, invalid);
        if (!nodeId || nodeId.length > 200) fail(invalid, `${label} contains an invalid node id`);
        if (!isPlainObject(rawNode)) fail(invalid, `${label}.${nodeId} must be a plain object`);
        for (const key of Object.keys(rawNode)) {
            safeKey(key, `${label}.${nodeId}`, invalid);
            if (!['class_type', 'inputs', '_meta'].includes(key)) fail(invalid, `${label}.${nodeId} contains unsupported field: ${key}`);
        }
        if (typeof rawNode.class_type !== 'string' || !rawNode.class_type.trim() || rawNode.class_type.length > 500) {
            fail(invalid, `${label}.${nodeId}.class_type must be a non-empty string`);
        }
        if (!isPlainObject(rawNode.inputs)) fail(invalid, `${label}.${nodeId}.inputs must be a plain object`);
        const inputs = cloneJson(rawNode.inputs, `${label}.${nodeId}.inputs`, state, 2);
        const node = { inputs, class_type: rawNode.class_type };
        if (rawNode._meta !== undefined) node._meta = cloneJson(rawNode._meta, `${label}.${nodeId}._meta`, state, 2);
        workflow[nodeId] = node;
    }
    return workflow;
}

const PROMPT_CONTROL_INPUT = /^(action|mode|operation|method|behavior|type|device)$/i;

function normalizeBinding(value, role, workflow, label, invalid) {
    if (!isPlainObject(value)) fail(invalid, `${label}.${role} must be an object`);
    for (const key of Object.keys(value)) {
        safeKey(key, `${label}.${role}`, invalid);
        if (!['node', 'input', 'mode'].includes(key)) fail(invalid, `${label}.${role} contains unsupported field: ${key}`);
    }
    const node = String(value.node ?? '');
    const input = value.input;
    if (!node || node.length > 200 || !Object.hasOwn(workflow, node)) fail(invalid, `${label}.${role}.node does not exist in workflow`);
    if (typeof input !== 'string' || !input || input.length > 500 || FORBIDDEN_KEYS.has(input)) fail(invalid, `${label}.${role}.input is invalid`);
    if (!Object.hasOwn(workflow[node].inputs, input)) fail(invalid, `${label}.${role} targets a workflow input that does not exist`);
    if (['prompt', 'negative'].includes(role) && PROMPT_CONTROL_INPUT.test(input)) {
        fail(invalid, `${label}.${role} targets a workflow control input rather than prompt text`);
    }
    const mode = value.mode ?? 'replace';
    if (!['replace', 'append', 'prepend'].includes(mode)) fail(invalid, `${label}.${role}.mode must be replace, append, or prepend`);
    if (!['prompt', 'negative'].includes(role) && mode !== 'replace') fail(invalid, `${label}.${role}.mode must be replace`);
    if (mode !== 'replace' && typeof workflow[node].inputs[input] !== 'string') fail(invalid, `${label}.${role}.mode requires a literal string input`);
    return { node, input, ...(mode === 'replace' ? {} : { mode }) };
}

export function validateComfyBindings(value, workflow, label = 'bindings', invalid = defaultInvalid) {
    if (!isPlainObject(value)) fail(invalid, `${label} must be an object`);
    const roles = new Set(['prompt', 'negative', 'seed', 'width', 'height']);
    for (const key of Object.keys(value)) {
        safeKey(key, label, invalid);
        if (!roles.has(key)) fail(invalid, `${label} contains unsupported field: ${key}`);
    }
    if (value.prompt === undefined) fail(invalid, `${label}.prompt is required`);
    const result = { prompt: normalizeBinding(value.prompt, 'prompt', workflow, label, invalid) };
    for (const role of ['negative', 'seed', 'width', 'height']) {
        if (value[role] !== undefined) result[role] = normalizeBinding(value[role], role, workflow, label, invalid);
    }
    return result;
}

export function applyComfyBindings(profile, request) {
    const workflow = structuredClone(profile.workflow);
    const values = {
        prompt: request.prompt,
        negative: request.negative,
        seed: request.seed,
        width: request.width,
        height: request.height,
    };
    for (const [role, binding] of Object.entries(profile.bindings)) {
        const value = values[role];
        if (value === undefined || value === null) continue;
        const node = workflow[binding.node];
        const current = node.inputs[binding.input];
        if (binding.mode === 'append') node.inputs[binding.input] = `${current}${value}`;
        else if (binding.mode === 'prepend') node.inputs[binding.input] = `${value}${current}`;
        else node.inputs[binding.input] = value;
    }
    return workflow;
}

function isLink(value, workflow) {
    if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(Number(value[1]))) return false;
    return Object.hasOwn(workflow, String(value[0]));
}

function schemaInputs(objectInfo, classType) {
    const schema = objectInfo?.[classType]?.input;
    return schema && typeof schema === 'object' ? { ...(schema.required ?? {}), ...(schema.optional ?? {}) } : {};
}

function declaredType(objectInfo, classType, input) {
    const descriptor = schemaInputs(objectInfo, classType)[input];
    if (Array.isArray(descriptor)) return typeof descriptor[0] === 'string' ? descriptor[0].toUpperCase() : '';
    return '';
}

function nodeStep(workflow, node, input) {
    return { node: String(node), classType: workflow[String(node)]?.class_type ?? '', ...(input ? { input } : {}) };
}

function confidence(value) {
    return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function candidate(node, input, score, reason, path, mode) {
    return {
        binding: { node: String(node), input, ...(mode && mode !== 'replace' ? { mode } : {}) },
        confidence: confidence(score),
        reason,
        path,
    };
}

function uniqueCandidates(items) {
    const seen = new Set();
    return items
        .sort((a, b) => b.confidence - a.confidence || a.binding.node.localeCompare(b.binding.node) || a.binding.input.localeCompare(b.binding.input))
        .filter(item => {
            const key = `${item.binding.node}\u0000${item.binding.input}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function upstreamLiteralCandidates(workflow, objectInfo, startNode, { kind, baseScore, downstreamPath }) {
    const results = [];
    const queue = [{ node: String(startNode), path: [] }];
    const visited = new Set();
    const namePattern = kind === 'string' ? /text|string|prompt|value|template/i : kind === 'seed' ? /seed|noise/i : /width|height|size|dimension/i;
    while (queue.length) {
        const current = queue.shift();
        if (visited.has(current.node) || current.path.length > 12) continue;
        visited.add(current.node);
        const node = workflow[current.node];
        if (!node) continue;
        const currentStep = nodeStep(workflow, current.node);
        const path = [...current.path, currentStep];
        for (const [input, value] of Object.entries(node.inputs)) {
            if (isLink(value, workflow)) {
                queue.push({ node: String(value[0]), path: [nodeStep(workflow, current.node, input), ...current.path] });
                continue;
            }
            const type = declaredType(objectInfo, node.class_type, input);
            const literalMatches = kind === 'string' ? typeof value === 'string'
                : kind === 'seed' ? Number.isSafeInteger(value) && value >= 0
                    : Number.isSafeInteger(value) && value > 0;
            if (!literalMatches) continue;
            const typed = kind === 'string' ? type === 'STRING' : ['INT', 'INTEGER', 'NUMBER'].includes(type);
            const named = namePattern.test(input);
            if (!typed && !named) continue;
            const score = baseScore - current.path.length * 0.05 + (typed ? 0.08 : 0) + (named ? 0.05 : 0);
            results.push(candidate(current.node, input, score, `Literal ${kind} input upstream of the semantic target`, [...path, nodeStep(workflow, current.node, input), ...downstreamPath]));
        }
    }
    return results;
}

function conditioningEncoders(workflow, objectInfo, samplerNode, samplerInput) {
    const start = workflow[samplerNode]?.inputs?.[samplerInput];
    if (!isLink(start, workflow)) return [];
    const results = [];
    const queue = [{ node: String(start[0]), path: [nodeStep(workflow, samplerNode, samplerInput)] }];
    const visited = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (visited.has(current.node) || current.path.length > 16) continue;
        visited.add(current.node);
        const node = workflow[current.node];
        if (!node) continue;
        const outputs = objectInfo?.[node.class_type]?.output;
        const conditioningLike = /clip.*text.*encode|text.*encode/i.test(node.class_type)
            || (Array.isArray(outputs) && outputs.some(type => String(type).toUpperCase() === 'CONDITIONING'));
        const textInputs = Object.keys(node.inputs).filter(input => /text|prompt|string/i.test(input) || declaredType(objectInfo, node.class_type, input) === 'STRING');
        if (conditioningLike && textInputs.length) results.push({ node: current.node, textInputs, path: [nodeStep(workflow, current.node), ...current.path] });
        for (const [input, value] of Object.entries(node.inputs)) {
            if (isLink(value, workflow)) queue.push({ node: String(value[0]), path: [nodeStep(workflow, current.node, input), ...current.path] });
        }
    }
    return results;
}

/** Analyze a validated ComfyUI API prompt and suggest explicit, confirmable bindings. */
export function analyzeComfyWorkflow(workflow, objectInfo = null) {
    const nodes = Object.entries(workflow);
    const liveInfo = isPlainObject(objectInfo) ? objectInfo : null;
    const missingClassTypes = liveInfo
        ? [...new Set(nodes.map(([, node]) => node.class_type).filter(classType => !Object.hasOwn(liveInfo, classType)))].sort()
        : [];
    const prompt = [];
    const negative = [];
    const seed = [];
    const width = [];
    const height = [];
    const samplers = [];

    for (const [nodeId, node] of nodes) {
        const inputNames = Object.keys(node.inputs);
        const isSampler = /sampler/i.test(node.class_type) || (inputNames.includes('positive') && inputNames.includes('negative'));
        if (!isSampler) continue;
        samplers.push(nodeId);
        for (const role of ['positive', 'negative']) {
            if (!Object.hasOwn(node.inputs, role)) continue;
            for (const encoder of conditioningEncoders(workflow, liveInfo, nodeId, role)) {
                // A zeroed conditioning branch deliberately has no textual
                // negative prompt. Do not suggest its positive source as a
                // negative binding.
                if (role === 'negative' && encoder.path.some(step => /ConditioningZeroOut/i.test(step.classType))) continue;
                for (const textInput of encoder.textInputs) {
                    const value = workflow[encoder.node].inputs[textInput];
                    const base = role === 'positive' ? 0.98 : 0.96;
                    const target = role === 'positive' ? prompt : negative;
                    if (isLink(value, workflow)) {
                        target.push(...upstreamLiteralCandidates(workflow, liveInfo, String(value[0]), {
                            kind: 'string', baseScore: base - 0.08, downstreamPath: [...encoder.path],
                        }));
                    } else if (typeof value === 'string') {
                        target.push(candidate(encoder.node, textInput, base, `${role} CONDITIONING text encoder feeding sampler ${nodeId}`, [nodeStep(workflow, encoder.node, textInput), ...encoder.path]));
                    }
                }
            }
        }
        for (const input of inputNames.filter(name => /^(?:seed|noise_seed)$/i.test(name))) {
            const value = node.inputs[input];
            if (isLink(value, workflow)) {
                seed.push(...upstreamLiteralCandidates(workflow, liveInfo, String(value[0]), { kind: 'seed', baseScore: 0.88, downstreamPath: [nodeStep(workflow, nodeId, input)] }));
            } else if (Number.isSafeInteger(value) && value >= 0) {
                seed.push(candidate(nodeId, input, 0.98, `Sampler seed input on ${node.class_type}`, [nodeStep(workflow, nodeId, input)]));
            }
        }
    }

    for (const [nodeId, node] of nodes) {
        for (const role of ['width', 'height']) {
            if (!Object.hasOwn(node.inputs, role) || isLink(node.inputs[role], workflow)) continue;
            const value = node.inputs[role];
            if (!Number.isSafeInteger(value) || value < 1) continue;
            const latentLike = /latent|empty.*image|canvas|size/i.test(node.class_type);
            const typed = ['INT', 'INTEGER', 'NUMBER'].includes(declaredType(liveInfo, node.class_type, role));
            const score = 0.62 + (latentLike ? 0.25 : 0) + (typed ? 0.08 : 0);
            (role === 'width' ? width : height).push(candidate(nodeId, role, score, `${role} literal on ${node.class_type}`, [nodeStep(workflow, nodeId, role)]));
        }
    }

    const outputs = nodes
        .filter(([, node]) => /saveimage|previewimage/i.test(node.class_type))
        .map(([node, info]) => ({ node, classType: info.class_type, confidence: /saveimage/i.test(info.class_type) ? 0.98 : 0.88, path: [nodeStep(workflow, node)] }))
        .sort((a, b) => b.confidence - a.confidence || a.node.localeCompare(b.node));

    return {
        nodeCount: nodes.length,
        objectInfoAvailable: Boolean(liveInfo),
        missingClassTypes,
        samplers,
        candidates: {
            prompt: uniqueCandidates(prompt),
            negative: uniqueCandidates(negative),
            seed: uniqueCandidates(seed),
            width: uniqueCandidates(width),
            height: uniqueCandidates(height),
            outputNode: outputs,
        },
    };
}
