# AI Translator Assistant

A Chrome extension that translates and refines text using Chrome's built-in AI.
Everything runs on-device — no translation servers, no API keys, no accounts.

Select text on any page, right-click, and get an English translation in a panel
you can drag wherever you want. Or paste text straight into the toolbar popup.

## Features

- **Automatic language detection** with a readable "Detected Language" label
- **Two modes** — translate only (fast, the default), or translate and then refine
- **Tone control** for refinement: professional, casual, or friendly
- **Draggable panel** that appears in-page and stays out of your way
- **Inline replace** — if you selected text inside a text field or editor, the
  result can be written back in place
- **Progressive output** — the translation renders as soon as it's ready, and
  refinement fills in afterward rather than blocking the UI
- **Copy** the refined text, or the translation when refinement isn't available

## Requirements

- Chrome 138 or newer (set in `manifest.json` as `minimum_chrome_version`)
- Chrome's built-in AI enabled, with the on-device model downloaded

The built-in AI APIs roll out at different paces. Translation and language
detection are the baseline; the refinement step depends on the Rewriter,
Proofreader, and Prompt APIs, which may not be present in every Chrome build.
When refinement isn't available the extension says so and still gives you the
translation — it doesn't fail or throw errors at you.

## Install

**From source (development):**

1. Clone this repository
2. Go to `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked** and select the repository folder

**From a packaged zip:**

Build one with the packaging step below, then drag the zip onto
`chrome://extensions` with Developer mode enabled.

## Usage

**On a webpage:** highlight text, right-click, choose **Translate & Improve with
AI**. The panel opens with the original and translated text. Drag it by its
header to move it.

**From the toolbar:** click the extension icon, paste text, pick a mode, and
click **Run**.

### Modes

| Mode | Behavior |
| --- | --- |
| **Translate** (default) | Detects the language and translates to English. Nothing else runs, so it returns faster. Results are cached. |
| **Translate + Improve** | Translates first, then rewrites for grammar and flow in the tone you picked. Shows a separate **Refined** section. |

Tone only applies to refinement, so the selector is disabled in Translate mode.
Changing the tone re-runs refinement on the same text.

## How it works

The pipeline lives in `content.js` and runs entirely in the browser:

1. **Detect** — `LanguageDetector`, falling back to the Prompt API if the
   detector is unavailable or low-confidence
2. **Translate** — `Translator` for the detected language pair, falling back to
   the Prompt API for languages it doesn't cover
3. **Refine** (opt-in) — the Prompt API with a tone-specific instruction, falling
   back to `Rewriter`

Each stage degrades rather than failing. If refinement produces nothing
meaningfully different from the translation, it's reported as unavailable
instead of showing you the same sentence twice.

## Privacy

The extension does not send your text anywhere. There are no `fetch` or
`XMLHttpRequest` calls in the source, no external script or module references,
and no analytics. Text you select is processed by Chrome's on-device model and
never leaves your machine.

Full policy: https://pranay847.github.io/ai-translator-assistant/

## Project structure

```
manifest.json    Manifest V3 configuration
background.js    Service worker — registers the context menu, routes selections
content.js       AI pipeline + in-page draggable panel (shadow DOM)
popup.html       Toolbar popup markup
popup.js         Popup logic, reuses the pipeline from content.js
styles.css       Popup styles
icons/           Toolbar icon (128px)
```

## Packaging

The zip must store paths with forward slashes. PowerShell's `Compress-Archive`
writes `icons\icon.png` with a backslash on Windows, which is not valid per the
ZIP spec — Chrome then can't resolve the icon path in `manifest.json` and the
upload fails with a "Could not load icon" error.

Build the zip with .NET's `ZipArchive` instead, setting entry names explicitly:

```powershell
Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$entry = $zip.CreateEntry('icons/QuickTranslateIcon_128.png')  # forward slash
```

Verify before uploading:

```powershell
[System.IO.Compression.ZipFile]::OpenRead($out).Entries.FullName
```

No entry should contain a backslash.
