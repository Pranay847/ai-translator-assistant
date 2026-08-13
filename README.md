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
- **Live progress** — model downloads report a percentage, and refinement shows a
  running elapsed count so a long wait never looks like a freeze
- **Stop** — abandon a slow refinement and keep the translation you already have
- **Copy** the refined text, or the translation when refinement isn't available

## Requirements

- Chrome 138 or newer (set in `manifest.json` as `minimum_chrome_version`)
- Chrome's built-in AI enabled

The built-in AI APIs ship at different paces, so what you get depends on your
Chrome build. Measured on Chrome 151:

| API | Used for | Status on Chrome 151 |
| --- | --- | --- |
| `LanguageDetector` | detecting the source language | available |
| `Translator` | translating to English | downloads one pack per language pair |
| `LanguageModel` (Prompt) | refinement, and fallback translation | needs a one-time download of roughly 2 GB |
| `Rewriter` | secondary refinement path | not present |
| `Proofreader` | not currently wired in | not present |

Refinement therefore runs on the Prompt API. If that model isn't available, the
extension still translates and tells you refinement is unavailable — it doesn't
fail or surface raw errors.

## First run

Chrome requires a user gesture before it will start downloading a model, so the
first translation for a given language needs one click.

**In the page panel:** a setup card appears explaining what needs downloading,
with a **Download & Continue** button. Click it and the download starts, showing
a percentage as it goes. The translation then completes on its own.

**In the popup:** the status line asks you to click **Run** again. That second
click is the gesture Chrome needs.

This happens once per model. Downloads are per language pair, so the first
Spanish translation and the first Japanese translation each need their own click.
Refinement needs one too, because it uses a separate (and much larger) model.

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

Translation typically returns in well under a second once the language pack is
downloaded. Refinement is much slower — around 20 to 30 seconds is normal — which
is why the translation is shown as soon as it's ready and a **Stop** button is
available while refinement runs.

## How it works

The pipeline lives in `content.js` and runs entirely in the browser:

1. **Detect** — `LanguageDetector`, falling back to the Prompt API if the
   detector is unavailable or low-confidence
2. **Translate** — `Translator` for the detected language pair, falling back to
   the Prompt API for languages it doesn't cover
3. **Refine** (opt-in) — the Prompt API with a tone-specific instruction, falling
   back to `Rewriter` where that exists

Each stage degrades rather than failing. If refinement produces nothing
meaningfully different from the translation, it's reported as unavailable
instead of showing you the same sentence twice.

Model creation is funnelled through a single guarded path that:

- catches the specific `NotAllowedError` Chrome raises when a download needs a
  user gesture, and asks the UI for a real click instead of surfacing the error
- distinguishes that from the same-named error thrown when a cross-origin frame
  is blocked by Permissions Policy, which a click would never fix
- bounds every wait, using download progress events as a liveness signal — a
  genuinely slow multi-gigabyte download is never cancelled, but a wedged one
  gives up and reports why
- reports what actually went wrong (timed out, setup needed, text too long)
  rather than always blaming the Chrome setup

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

There is no `content_scripts` entry in the manifest. `content.js` is injected on
demand by `background.js` via `chrome.scripting.executeScript`, which keeps the
permission footprint narrow; a guard in the file makes re-injection a no-op.

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
