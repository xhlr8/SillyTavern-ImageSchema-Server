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
GET  /outputs/:outputId
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

Resolution reuses the current exact or compatible durable output before provider generation. Ordinary reloads do not regenerate. Use `{ "regenerate": true }` or `POST /outputs/regenerate` for an explicit new revision. `GET /outputs/:outputId` serves the exact authenticated-user bytes with private immutable caching and returns `output_not_found` (404) when absent.

`/cache/clear` clears only the accelerator cache. Durable output deletion is explicit.

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
