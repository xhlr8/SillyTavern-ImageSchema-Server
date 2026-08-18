# Image Schema SillyTavern server plugin

This directory is the server half of the Image Schema implementation. It runs inside SillyTavern, mounts same-origin routes under `/api/plugins/image-schema`, keeps provider credentials on the server, and caches successful image bytes on disk.

Install the companion [`../extension/`](../extension/) to teach models the virtual schema and render images in chat.

## Installation

1. Copy this directory's contents to:

   ```text
   SillyTavern/plugins/image-schema/
   ```

   The installed directory must contain `package.json`, `index.mjs`, and `core.mjs` directly.

2. Install the YAML dependency from the installed plugin directory:

   ```bash
   npm install --omit=dev
   ```

   The plugin requires Node.js 20 or newer.

3. In SillyTavern's **main** `config.yaml`, enable server plugins:

   ```yaml
   enableServerPlugins: true
   ```

   This option is separate from `plugin/config.yaml`. Restart SillyTavern after changing it. Server plugins are unsandboxed and run with the SillyTavern process's filesystem/network permissions; install only trusted plugins.

4. Copy the example next to `index.mjs`:

   ```powershell
   Copy-Item config.example.yaml config.yaml
   ```

   ```bash
   cp config.example.yaml config.yaml
   ```

5. Edit `config.yaml`, remove unused profiles, select `defaultProfile`, and provide referenced environment variables to the process that starts SillyTavern. The example's `../static/error_images/...` paths assume this repository layout and will not exist in a plugin-only copy. Fallbacks are optional: copy those files to a server-readable location and update the paths, or remove `errorImages`.

6. Restart SillyTavern and look for a message similar to:

   ```text
   [image-schema] loaded 1 profile(s) from ...config.yaml
   ```

7. In the Image Schema extension settings, run **Check plugin** and **Test generation**.

## Configuration file and environment variables

By default the plugin reads `config.yaml` in its own directory. Override the path with:

```text
SILLYTAVERN_IMAGE_CONFIG=/absolute/or/plugin-relative/path.yaml
```

An absolute value is used as-is. A relative value is resolved from the plugin directory, not from the shell's current working directory.

String values anywhere in YAML support:

```yaml
apiKey: ${OPENAI_API_KEY}          # required
optionalValue: ${NAME:-fallback}   # fallback when NAME is absent
```

Expansion is recursive and happens for the entire parsed document at plugin startup. A missing required variable in an unused profile still causes plugin initialization to fail. Delete profiles you do not use rather than leaving unresolved example secrets. Empty but defined environment variables count as values.

The example uses `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `IMAGE_API_KEY`; these names are examples, not hard-coded requirements. Any environment-variable name can be referenced in YAML.

Do not confuse this configuration with the repository-root legacy `config.yaml`; their schemas are incompatible.

## UI-managed provider profiles

The companion extension can create, edit, rename, delete, test, and select provider profiles from its **Provider Profiles** drawer. UI-managed changes are stored in `managed-config.json` beside the plugin by default, or at `SILLYTAVERN_IMAGE_MANAGED_CONFIG` when set. The file is atomically replaced and restricted to mode `0600` where supported.

The base `config.yaml` remains supported and is never overwritten. Managed profiles override same-named base profiles, can tombstone base profiles, and can select a managed default. Changes update active per-user image services without restarting SillyTavern.

Secrets use a dedicated write-only route. Sanitized configuration responses expose only whether a secret is configured; API-key values are never returned to the browser. Provider mutations require an administrator when SillyTavern supplies an `admin` property on the authenticated user profile.

Supported UI provider types are currently OpenAI-compatible, Gemini SSE, and generic GET/POST. The ComfyUI settings area is reserved for a future workflow adapter and is not functional yet.

## Top-level configuration

```yaml
defaultProfile: gemini

limits:
  maxPromptLength: 12000
  maxDimension: 4096
  maxResponseBytes: 52428800
  maxConcurrentRequests: 4

cache:
  enabled: true
  perUser: true
  directory: ./cache
  ttlSeconds: null

errorImages:
  rateLimit: ../static/error_images/error_429.png
  safety: ../static/error_images/error_safety.png
  timeout: ../static/error_images/error_timeout.png
  upstream: ../static/error_images/error_500.png
  unknown: ../static/error_images/error_unknown.png

profiles:
  # one or more named profiles
```

- `defaultProfile`: used when the extension does not send a profile. If omitted, validation selects the first profile in parsed object order; explicitly set it for predictable configuration.
- `limits.maxPromptLength`: plugin-side maximum after trimming; default `12000`.
- `limits.maxDimension`: maximum width or height; default `4096`. Dimensions must be positive safe integers.
- `limits.maxResponseBytes`: maximum image bytes accepted from providers or returned image URLs; default 50 MiB.
- `limits.maxConcurrentRequests`: maximum distinct in-flight generations per authenticated user; default `4`. Identical requests still deduplicate.
- `cache.enabled`: defaults to enabled.
- `cache.perUser`: defaults to `true`, placing each authenticated SillyTavern user's entries in a separate subdirectory. Set `false` only for a deliberately shared cache.
- `cache.directory`: relative paths resolve from the plugin directory; default `./cache`.
- `cache.ttlSeconds`: `null`/omitted means no expiry. A non-negative number opts into expiration; `0` effectively expires entries immediately on later reads.
- `errorImages`: optional paths for image-route fallback responses. Relative paths resolve from the plugin directory.
- `profiles`: must contain at least one profile. Names accept only letters, digits, `_`, and `-`.

Only `openai`, `gemini-sse`, and `generic` profile types are currently implemented.

## Normalized request and profile policy

The plugin accepts these request fields internally:

```text
prompt, profile/backend, width, height, seed, negative, model,
quality, outputFormat/output_format, background, enhance,
aspectRatio/aspect_ratio, imageSize/image_size, temperature,
personGeneration/person_generation
```

`id` is explicitly rejected. Seed is the only image identity/randomness field. Aspect ratio is restricted to `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, or `21:9`; image size to `1K`, `2K`, or `4K`; temperature to 0–2; and person generation to `ALLOW_ALL`, `ALLOW_ADULT`, or `ALLOW_NONE`. If aspect ratio is present and neither dimension was explicitly supplied, the plugin derives dimensions using image size (or 1024) within `maxDimension`.

Width and height fall back to profile `defaults.width`/`defaults.height`, then to 1024. Other generation fields use profile defaults where implemented. A request-supplied model is allowed only when the profile contains an `allowedModels` array, and the selected value must be in that array:

```yaml
profiles:
  selected-openai:
    type: openai
    url: https://api.openai.com/v1/images/generations
    apiKey: ${OPENAI_API_KEY}
    model: gpt-image-1
    allowedModels:
      - gpt-image-1
```

The browser cannot provide an arbitrary provider URL or authentication header; these remain fixed in the profile.

## Provider profiles

### OpenAI Images

```yaml
defaultProfile: openai
profiles:
  openai:
    type: openai
    url: https://api.openai.com/v1/images/generations
    apiKey: ${OPENAI_API_KEY}
    model: gpt-image-1
    timeoutMs: 180000
    defaults:
      width: 1024
      height: 1024
      quality: medium
      outputFormat: png
      background: opaque
    body:
      moderation: auto
```

Behavior:

- Sends Bearer authentication when `apiKey` is set; configured `headers` can provide/override headers.
- Sends `model`, prompt, `n: 1`, size, quality, background, and `output_format` after merging configured fixed `body` values.
- For models whose name starts with `gpt-image-2`, sends the normalized `WIDTHxHEIGHT` directly. Other models map dimensions to `1024x1024`, `1536x1024`, or `1024x1536` according to aspect ratio.
- Accepts the first `b64_json` image or downloads the first returned HTTP(S) URL.
- Does not currently send `seed`, negative prompt, or `enhance` to OpenAI.
- Does not implement the legacy Python server's retry policy, gpt-image-2 clamping/multiple-of-16 logic, or compression option.

### Gemini SSE

```yaml
defaultProfile: gemini
profiles:
  gemini:
    type: gemini-sse
    url: https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:streamGenerateContent
    apiKey: ${GEMINI_API_KEY}
    queryApiKey: true
    timeoutMs: 180000
    systemInstruction: Generate exactly one image. Output the image only.
    generationConfig:
      temperature: 1
    defaults:
      width: 1024
      height: 1024
```

Behavior:

- With `queryApiKey: true` (default), adds `?key=...`; with `false`, sends `x-goog-api-key`.
- Requests `IMAGE` and `TEXT` response modalities and scans SSE events for inline image data.
- If width or height is present in the normalized request (normally both are), prepends `Generate an image at WIDTHxHEIGHT:` to the text. A negative prompt is appended as `Avoid:` text.
- `generationConfig`, `imageConfig`, and `systemInstruction` are trusted profile settings.
- Validated request `temperature` is placed in `generationConfig`; aspect ratio, image size, and person-generation are placed in `generationConfig.imageConfig` and override matching fixed profile `imageConfig` values.
- Does not currently send a native `seed`, selected model field, output format, or `enhance` parameter.

### Generic GET returning image bytes

```yaml
defaultProfile: generic-get
profiles:
  generic-get:
    type: generic
    method: GET
    url: https://images.example.com/generate/{prompt}
    timeoutMs: 180000
    headers:
      Authorization: Bearer ${IMAGE_API_KEY}
    query:
      width: "{width}"
      height: "{height}"
      seed: "{seed}"
      negative: "{negative}"
```

`{prompt}` is percent-encoded when substituted into `url`. Query parameters are rendered and encoded by `URLSearchParams`. An exact placeholder whose value is `null`, `undefined`, or empty is omitted, so a seedless request does not send an empty seed in the example.

### Generic POST returning JSON/base64

```yaml
defaultProfile: generic-post
profiles:
  generic-post:
    type: generic
    method: POST
    url: https://images.example.com/v1/generate
    timeoutMs: 180000
    headers:
      Authorization: Bearer ${IMAGE_API_KEY}
    body:
      prompt: "{prompt}"
      negative_prompt: "{negative}"
      width: "{width}"
      height: "{height}"
      seed: "{seed}"
    responseImagePath: images.0.base64
    responseMimePath: images.0.mime_type
    responseEncoding: base64
```

Generic profiles support only `GET` and `POST`. Without `responseImagePath`, the response body must be image bytes. With a response path, dot/bracket tokens such as `images[0].data` select a value:

- `responseEncoding: base64` (default): decode base64 or a data URL.
- `responseEncoding: url`: treat the selected value as an image URL and fetch it.
- `responseMimePath`: optional MIME hint; actual bytes still must match a supported image signature.

Template placeholders currently available are the normalized request fields: `profile`, `prompt`, `width`, `height`, `seed`, `negative`, `model`, `quality`, `outputFormat`, `background`, `enhance`, `aspectRatio`, `imageSize`, `temperature`, and `personGeneration`. Templates are simple replacement, not an expression language.

## Caching and seed semantics

The cache key is a SHA-256 fingerprint of:

- cache-key format version;
- the complete normalized request; and
- the generation-affecting selected profile configuration, excluding API keys and sensitive authentication headers.

Canonical object key ordering makes equivalent objects stable. Generation-affecting profile edits create new keys, while rotating credentials alone does not. Cache entries are stored as `<key>.bin` plus `<key>.json` metadata and validated by an image SHA-256 ETag before use.

By default (`ttlSeconds: null`), **every successful result persists**, whether seeded or seedless. The first successful seedless result therefore becomes the stable result for that exact canonical request across plugin/SillyTavern restarts. Different seeds are different keys. Concurrent requests for one key are deduplicated so only one upstream operation runs.

Seed does not automatically make an upstream deterministic. Generic templates can send `{seed}`. The OpenAI and Gemini adapters currently do not send seed to their provider APIs, so it distinguishes plugin cache entries only.

Successful responses include `ETag`, `X-Image-Cache: HIT|MISS`, `X-Content-Type-Options: nosniff`, and cache headers. Persistent responses use a one-year `public, immutable` browser cache directive; expiring responses use the configured TTL. Fallback images use `X-Image-Cache: ERROR` and `Cache-Control: no-store`. Conditional `If-None-Match` requests receive `304`.

Important operational details:

- `/cache/clear` without a request removes matching `.bin` and `.json` files and reports the number of **files**, not logical image entries. With a canonical request body, it deletes that request's two cache paths.
- `/cache/stats` counts `.bin` entries and bytes; it does not proactively delete all expired/corrupt orphan files.
- `/cache/regenerate` deletes one canonical key and regenerates while bypassing cache reads.
- `/test` bypasses cache reads but successful test output is currently written to cache.
- The extension UI currently exposes bulk clear only; request-specific deletion/regeneration routes are plugin API capabilities.
- Browser-cached immutable bytes may remain visible after the disk entry is cleared.

## Routes

SillyTavern mounts the plugin router at `/api/plugins/image-schema`.

### `GET /image/:prompt`

Returns image bytes and is the route used by rewritten `<img>` elements. Prompt is in the path; options are query parameters. On eligible rate-limit, safety, timeout, upstream, invalid-image, or oversized-response failures, it attempts to return a configured fallback image and sets `X-Image-Error`. Validation/configuration errors return text instead.

### `POST /generate`

Accepts a JSON generation body and returns image bytes. It does not use fallback error images.

### `GET /status`

Returns `ok`, plugin version, `defaultProfile`, and the public profile views. This is the extension's connection check.

### `GET /profiles` and `POST /profiles`

Return `defaultProfile` and public profile views: name, default flag, type, configured model, and defaults. They do not return URLs, headers, bodies, or API keys.

### `POST /cache/stats`

Returns the authenticated user's cache enabled state, entry/byte counts, TTL, resolved directory, and current in-flight generation count.

### `POST /cache/clear`

With no `request` in the JSON body (or with `all: true`), bulk-removes plugin cache files. With `{ "request": { "text": "...", "params": { ... } } }`, normalizes the request and deletes that one canonical key's data/metadata paths.

### `POST /cache/regenerate`

Accepts a request, deletes its current canonical entry, regenerates while bypassing cache reads, writes the successful result, and returns metadata. The current extension UI does not call this endpoint.

### `POST /test`

Generates with the submitted values, or a small default prompt when none is supplied. Returns JSON metadata (`ok`, profile, MIME, bytes, cached flag, seed), not the image. Cache reads are bypassed.

### Provider-management routes

The extension uses `GET /providers/config` plus POST routes `/providers/profile/save`, `/providers/profile/delete`, `/providers/default`, `/providers/secret`, and `/providers/profile/test`. They accept strict allowlisted bodies. Config responses contain sanitized profile data and `apiKeyConfigured` only; secret values are never returned.

Lower-level `/config` routes are also available for administrative integrations, as documented by the source contract.

These routes are intentionally absent from the model instruction. The extension uses same-origin requests, but the plugin does not implement an additional user/role/quota layer of its own.

## Error handling and image validation

Provider timeouts default to 180 seconds per profile. HTTP 429 becomes `rate_limit`; policy-like response text may become `safety`; other failures are categorized for logs/fallbacks.

Accepted response signatures are PNG, JPEG, WebP, GIF, and AVIF. A misleading `Content-Type` cannot turn arbitrary bytes into an image. Both declared and actual response sizes are checked against `maxResponseBytes` when downloading byte responses. Base64-decoded output is checked after decoding.

Fallback images are available only on the GET image route and only for eligible runtime failures. Missing/unreadable fallback files fall back to the normal error response. Fallback images are sent as image responses but are not written into the generation cache.

## Security

- Server plugins are unsandboxed. The plugin and dependencies execute with SillyTavern's process privileges.
- Keep secrets in environment variables/service secret stores. Restrict read permissions on `config.yaml` and the cache directory.
- Protect the SillyTavern instance itself: users able to access plugin routes can potentially consume provider quota and clear their own cache. With `cache.perUser: false`, cache access is shared.
- Profile URLs and templates are trusted configuration. Browser requests cannot change them, but a malicious administrator/config edit can make requests to internal HTTP services.
- The generic adapter follows redirects and can fetch an upstream-returned URL when `responseEncoding: url`; there is currently no destination-host allowlist. Use only trusted providers.
- Error details and up to 500 characters of an upstream error body can appear in SillyTavern logs or client errors. Avoid providers that echo credentials in errors.
- `public` browser cache headers assume the generated image URL is safe to cache in the deployment's HTTP caching environment. Review reverse-proxy/shared-cache behavior for sensitive images.

## Tests

```bash
cd plugin
npm install
npm test
```

Tests mock network requests and cover canonical fingerprints, environment expansion, ID rejection/seed handling, OpenAI and Gemini decoding, generic GET/POST templating, JSON/base64 extraction, MIME sniffing, persistent versus expiring disk cache, and concurrent/restart cache behavior.

They do not test SillyTavern route mounting or live provider behavior.

## Troubleshooting

### Plugin does not load

- Confirm `enableServerPlugins: true` is in SillyTavern's main config and restart the process.
- Ensure the plugin is directly under `SillyTavern/plugins/image-schema/` and dependencies are installed.
- Confirm Node.js is at least version 20.
- Read the SillyTavern server log; plugin-loader errors are not shown only in the browser.

### Config error

- Copy `config.example.yaml` to `config.yaml`, not the root legacy `config.yaml`.
- Remove unused example profiles with missing environment variables.
- Verify `defaultProfile` exists, profile names are valid, profile types are supported, and every URL is absolute HTTP(S).
- Check that the service launching SillyTavern actually inherits the expected environment.
- Use `SILLYTAVERN_IMAGE_CONFIG` when configuration must live elsewhere.

### Invalid request/model

- Prompt is required and must fit both extension and plugin limits.
- Width/height must be positive integers no greater than `maxDimension`.
- `id` is unsupported; use seed.
- A client-selected model requires a profile `allowedModels` list containing it.
- A client-selected profile must match a configured name exactly.

### Provider returned no image

- Verify the endpoint matches the selected adapter (OpenAI JSON, Gemini SSE, generic bytes/JSON).
- For generic JSON, verify `responseImagePath`, encoding, and optional MIME path against the real response.
- Check authentication style, timeout, response size, and provider safety/rate limits.
- Only PNG/JPEG/WebP/GIF/AVIF bytes are accepted.

### Unexpected repeats/cache

- Persistent seedless caching is the default, not a bug. Clear cache, change seed/request, or set an explicit TTL.
- Profile defaults and the profile object are part of identity; changing them produces new entries but does not delete old files.
- Cache clear reports files (typically twice the image count), while stats reports image entries.

## Legacy limitations and migration

The repository-root `image-server.py` remains a separate FastAPI service and may run alongside this plugin on its own port. Its root `config.yaml` cannot be reused directly. The new plugin does not currently implement the legacy server's dedicated ComfyUI workflow adapter, aggregator/path-prefix model, retries, `nologo`, gpt-image-2 clamping/multiple-of-16/compression behavior, or its cache format.

Old absolute URLs such as `http://localhost:9988/image/...` continue to target the Python service; the extension rewrites only its configured virtual same-origin path. Keep the legacy process for old messages or migrate those message URLs explicitly. Do not share cache directories between implementations.
