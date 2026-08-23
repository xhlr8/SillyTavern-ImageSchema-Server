# SillyTavern Image Schema Server

Private SillyTavern server plugin for [SillyTavern-ImageSchema](https://github.com/xhlr8/SillyTavern-ImageSchema). It owns provider credentials, executes image requests, validates ComfyUI workflows, records safe diagnostics, and serves durable generated outputs.

## Install / update

Clone this private repository into:

```text
SillyTavern/plugins/image-schema/
```

```bash
git clone https://github.com/xhlr8/SillyTavern-ImageSchema-Server.git plugins/image-schema
cd plugins/image-schema
npm install --omit=dev
cp config.example.yaml config.yaml
```

Private pulls require GitHub credentials on the SillyTavern host.

Enable server plugins in SillyTavern's main `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart SillyTavern after installing or updating server-plugin code.

## Configuration

Provider profiles can be managed from the companion extension UI. `config.yaml` remains useful for bootstrap profiles and environment-backed secrets.

Minimal example:

```yaml
defaultProfile: example-openai

cache:
  enabled: true
  perUser: true
  directory: ./cache
  ttlSeconds: null

outputs:
  enabled: true
  directory: ./outputs
  includePrompt: false

profiles:
  example-openai:
    type: openai
    url: https://images.example.com/v1/images/generations
    apiKey: ${IMAGE_SCHEMA_API_KEY}
    model: example-image-model
```

Environment placeholders use `${NAME}` or `${NAME:-fallback}`. Never commit `config.yaml`, `managed-config.json`, cache data, outputs, or credentials.

## Providers

- **OpenAI-compatible** image generation endpoints.
- **Gemini / Nano Banana** using Interactions API for Gemini 3 image models and legacy GenerateContent streaming where applicable.
- **Generic HTTP** GET/POST profiles with fixed server-owned templates.
- **ComfyUI** API workflows with explicit/analyzed prompt, negative, seed, dimension, and output bindings.

ComfyUI profiles treat the uploaded API workflow as authoritative: model, VAE, LoRAs, sampler, scheduler, and custom nodes remain whatever the workflow defines.

## Durable outputs

Successful images are written before being returned:

```text
outputs/<hashed-user-scope>/<request-key>.<ext>
outputs/<hashed-user-scope>/<request-key>.json
```

The internal cache is only an accelerator. A second browser or phone using the same authenticated SillyTavern user and normalized request receives the durable bytes without rerunning the provider. Legacy cache hits are promoted to outputs automatically.

Each successful output has an immutable 64-character `outputId`. The normalized request key is the first output's ID; explicit regeneration creates a new immutable revision ID and advances a small per-request current pointer without overwriting either revision. Exact retrieval is scoped to the authenticated user and does not consult current profiles, models, workflows, or routing.

Metadata stores a prompt hash by default; set `outputs.includePrompt: true` only if raw prompt retention is desired.

Useful routes under `/api/plugins/image-schema`:

```text
GET  /status
GET  /image/:prompt
GET  /providers/config
POST /providers/profile/save
POST /providers/comfy/analyze
GET  /diagnostics/recent
GET  /outputs/stats
POST /outputs/clear
POST /resolve
POST /outputs/resolve
POST /outputs/regenerate
POST /outputs/migrate
POST /outputs/delete
GET  /outputs?limit=40&cursor=<opaque>
GET  /outputs/:outputId
GET  /outputs/:outputId/thumbnail
GET  /references/:chatId
POST /references/list
POST /references/upsert
POST /references/remove
```

`POST /resolve` and `POST /outputs/resolve` accept `{ "request": <normalized request>, "regenerate"?: boolean }` and return:

```json
{
  "outputId": "<immutable id>",
  "requestKey": "<normalized request key>",
  "outputUrl": "/api/plugins/image-schema/outputs/<outputId>",
  "metadata": {
    "mime": "image/png",
    "bytes": 123,
    "etag": "<sha256>",
    "createdAt": "<ISO timestamp>",
    "cached": true,
    "requestedProfile": "example-openai",
    "effectiveProfile": "example-openai",
    "fallbackReason": null,
    "revisionOf": null
  }
}
```

Resolution reuses the current exact durable output first. Seeded compatibility promotion on an ordinary reload is restricted to the exact provider/workflow fingerprint or an explicit `outputs.profileAliases` entry; it never silently adopts arbitrary profile or workflow bytes. Ordinary reloads do not regenerate. Use `{ "regenerate": true }` or `POST /outputs/regenerate` for an explicit new revision. `POST /outputs/migrate` accepts the same request body (without regeneration) and explicitly opts into profile-agnostic recovery when prompt hash, seed, and every non-profile normalized parameter match. `GET /outputs/:outputId` serves the exact authenticated-user bytes with private immutable caching and returns `output_not_found` (404) when absent.

### Gallery API

All Gallery and reference routes require authentication and are scoped to the current SillyTavern user.

`GET /outputs` returns newest-first durable output metadata. `limit` defaults to 40 and accepts 1–100; pass the opaque `nextCursor` as `cursor` to fetch the next page. Items include output/request/revision IDs, timestamps, MIME/byte/ETag data, provider provenance, safe normalized generation settings, and authenticated output/thumbnail URLs. Prompt hashes are not exposed. Raw prompts are omitted unless both the output already contains one and the current configuration explicitly enables `outputs.includePrompt`.

The initial exact-thumbnail contract intentionally adds no image-processing dependency: `GET /outputs/:outputId/thumbnail` returns the original authenticated-user image bytes, with `X-Thumbnail-Source: original` and `X-Thumbnail-Contract: original-v1`. Listing items likewise report `thumbnail: { "kind": "original", "resized": false }` so clients need not infer resizing.

Per-chat reference manifests identify a slot by `chatId`, `messageId`, `swipeKey`, and `slotId`:

- `POST /references/upsert` accepts those fields plus `activeOutputId` and `historyIds`. Every referenced output must belong to the authenticated user, and history must contain the active ID.
- `GET /references/:chatId` lists that user's references for one chat; `POST /references/list` with `{ "chatId": ... }` is the preferred equivalent for IDs containing reserved URL characters.
- `POST /references/remove` accepts the four identity fields and idempotently removes that reference.

`/cache/clear` clears only the accelerator cache. Durable output deletion is explicit. `POST /outputs/delete` accepts `{ "outputId": "<id>", "family"?: boolean, "force"?: boolean }`; family deletion removes every immutable revision sharing the request key. A normal delete or clear refuses to remove outputs named by an active/history reference manifest (`output_referenced`, 409), while `force` also scrubs those references. `POST /outputs/clear` accepts `{ "all": true, "force"?: boolean }` or `{ "request": {...}, "force"?: boolean }`; clear is authenticated, skips live persistence locks, recovers expired locks, and invalidates promotable accelerator entries.

## Security

- Credentials are write-only from the UI and are not returned to the browser.
- Provider URLs come from server-managed profiles, not model output.
- Managed config uses atomic writes and restricted permissions where supported.
- Diagnostic events omit prompts, URLs, headers, bodies, credentials, and raw upstream errors.
- Durable output directories and exact retrieval are always authenticated-user scoped, even when accelerator caching is shared.
- Server plugins are unsandboxed; install only trusted code.

## Development

```bash
npm test
```

The repository root contains `package.json` and `index.mjs`, so SillyTavern's plugin loader can discover it directly after cloning into `plugins/image-schema`.
