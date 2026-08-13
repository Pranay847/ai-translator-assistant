(() => {
  const MSG_RUN_SELECTION = "quicktranslate.runSelection";
  const PANEL_ID = "ai-translator-panel";
  const EXTENSION_BASE = chrome.runtime.getURL("");
  const IS_EXTENSION_PAGE = location.href.startsWith(EXTENSION_BASE);
  const TARGET_LANGUAGE = "en";
  const MIN_LANGUAGE_CONFIDENCE = 0.25;

  if (!IS_EXTENSION_PAGE && globalThis.__quickTranslateContentLoaded) {
    return;
  }

  if (!IS_EXTENSION_PAGE) {
    globalThis.__quickTranslateContentLoaded = true;
  }

  const TONE_OPTIONS = [
    { value: "professional", label: "Professional" },
    { value: "casual", label: "Casual" },
    { value: "friendly", label: "Friendly" }
  ];

  const MODE_OPTIONS = [
    { value: "translate", label: "Translate" },
    { value: "improve", label: "Translate + Improve" }
  ];

  const PROMPT_MODEL_OPTIONS = {
    expectedInputs: [{ type: "text", languages: ["en", "es", "ja"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }]
  };
  const FAST_REFINE_TIMEOUT_MS = 7000;
  // Refinement measured ~27s on a warm machine, so 30s flaked. This bounds generation only:
  // model download is covered separately by the create watchdog below.
  const PROMPT_REFINE_TIMEOUT_MS = 120000;
  const PROMPT_TIMEOUT_MS = 30000;
  const MAX_PROMPT_REFINE_CHARS = 4000;
  const AVAILABILITY_TIMEOUT_MS = 10000;
  const DETECT_TIMEOUT_MS = 15000;
  const TRANSLATE_TIMEOUT_MS = 60000;
  // A real download proves it is alive: Chrome emits downloadprogress roughly every 50ms.
  // Wait generously for the first event, then treat 60s of silence as a wedged create.
  const CREATE_FIRST_PROGRESS_TIMEOUT_MS = 180000;
  const CREATE_STALL_TIMEOUT_MS = 60000;
  const SETUP_GESTURE_TIMEOUT_MS = 120000;

  const TRANSLATOR_LANGUAGES = new Set([
    "ar",
    "bg",
    "bn",
    "cs",
    "da",
    "de",
    "el",
    "en",
    "es",
    "fi",
    "fr",
    "hi",
    "hr",
    "hu",
    "id",
    "it",
    "iw",
    "ja",
    "kn",
    "ko",
    "lt",
    "mr",
    "nl",
    "no",
    "pl",
    "pt",
    "ro",
    "ru",
    "sk",
    "sl",
    "sv",
    "ta",
    "te",
    "th",
    "tr",
    "uk",
    "vi",
    "zh",
    "zh-Hant"
  ]);

  const languageNames = (() => {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      return null;
    }
  })();

  let panelController;
  let activeRunId = 0;
  let lastEditableTarget = null;
  let lastResult = null;
  let detectorPromise = null;
  let proofreaderPromise = null;
  const translatorPromises = new Map();
  const rewriterPromises = new Map();
  const promptSessionPromises = new Map();
  const pipelineCache = new Map();

  // A shared model download is created once, so its progress cannot belong to one run's
  // callback. These point at whatever run is currently on screen.
  let statusSink = () => {};
  let gestureRequester = null;
  let activeCancel = null;

  class QuickTranslateSetupError extends Error {
    constructor(message) {
      super(message);
      this.name = "QuickTranslateSetupError";
    }
  }

  function timeoutError(message) {
    const error = new Error(message);
    error.name = "QuickTranslateTimeout";
    return error;
  }

  // Races rather than only aborting: abort is best effort, and an implementation that ignores
  // the signal would otherwise leave a promise that never settles.
  function withDeadline(promise, ms, message) {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(message)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  function forgetIfCurrent(map, key, pending) {
    if (map.get(key) === pending) {
      map.delete(key);
    }
  }

  function needsUserGesture(error) {
    // The message test is load-bearing: a cross-origin frame blocked by Permissions Policy
    // also throws NotAllowedError, and routing that to a setup card would loop forever.
    return error?.name === "NotAllowedError" && /user gesture/i.test(error?.message || "");
  }

  function isPermissionsPolicyBlock(error) {
    return error?.name === "NotAllowedError" && /permission[s]? policy/i.test(error?.message || "");
  }

  function startElapsedTicker(label) {
    const startedAt = Date.now();
    statusSink(`${label}...`);
    const timer = setInterval(() => {
      statusSink(`${label}... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 1000);
    return () => clearInterval(timer);
  }

  async function requestDownloadGesture(label) {
    if (!gestureRequester) {
      throw new QuickTranslateSetupError(
        `One-time setup needed: Chrome must download the ${label}. Click Run again to start the download — it happens once and then works offline.`
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new QuickTranslateSetupError(`Setup for the ${label} was not started.`));
      }, SETUP_GESTURE_TIMEOUT_MS);

      gestureRequester({
        label,
        proceed() {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  // Bounds create() without aborting it: aborting could cancel a multi-GB browser-level
  // download. A late model from an abandoned attempt is destroyed rather than leaked.
  function createModelOnce(factory, options, label) {
    let settled = false;
    let abandoned = false;
    let timer = null;
    let rejectGuard = () => {};

    const guard = new Promise((_, reject) => {
      rejectGuard = reject;
    });

    const beat = (ms) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        abandoned = true;
        rejectGuard(timeoutError(`Preparing the ${label} took too long. Check your connection and try again.`));
      }, ms);
    };

    const pending = factory.create({
      ...options,
      monitor: createDownloadMonitor(label, () => beat(CREATE_STALL_TIMEOUT_MS))
    });

    beat(CREATE_FIRST_PROGRESS_TIMEOUT_MS);

    pending.then(
      (model) => {
        if (abandoned) {
          model?.destroy?.();
        }
      },
      () => {}
    );

    const tracked = pending.then(
      (value) => {
        settled = true;
        clearTimeout(timer);
        return value;
      },
      (error) => {
        settled = true;
        clearTimeout(timer);
        throw error;
      }
    );

    return Promise.race([tracked, guard]);
  }

  async function createModel(factory, options, label) {
    try {
      return await createModelOnce(factory, options, label);
    } catch (error) {
      if (isPermissionsPolicyBlock(error) && !needsUserGesture(error)) {
        throw new Error("This page blocks Chrome's built-in AI. Open the extension popup from the toolbar and paste the text there.");
      }

      if (!needsUserGesture(error)) {
        throw error;
      }

      // The failing create() started no download and had no side effects, so retrying after a
      // real in-page click is safe. The click grants full transient activation.
      await requestDownloadGesture(label);
      return createModelOnce(factory, options, label);
    }
  }

  async function runPipeline(text, tone = "professional", onStatus = () => {}, options = {}) {
    const sink = typeof onStatus === "function" ? onStatus : () => {};
    const requester = typeof options.onNeedsGesture === "function" ? options.onNeedsGesture : null;
    statusSink = sink;
    gestureRequester = requester;

    try {
      return await runPipelineInner(text, tone, sink, options);
    } finally {
      if (statusSink === sink) {
        statusSink = () => {};
      }
      if (gestureRequester === requester) {
        gestureRequester = null;
      }
    }
  }

  async function runPipelineInner(text, tone = "professional", onStatus = () => {}, options = {}) {
    const original = text.trim();
    const mode = options.mode === "improve" ? "improve" : "translate";
    const onPartial = typeof options.onPartial === "function" ? options.onPartial : () => {};
    if (!original) {
      throw new Error("Select or enter text first.");
    }

    const cacheKey = `${mode}:${tone}:${original}`;
    const canUseCache = mode === "translate";
    if (canUseCache && pipelineCache.has(cacheKey)) {
      const cached = pipelineCache.get(cacheKey);
      onStatus("Loaded from cache");
      onPartial(cached);
      return cached;
    }

    onStatus("Preparing local AI");
    const detectedLanguage = await detectLanguage(original, onStatus);
    onPartial({ original, detectedLanguage, mode, tone });
    const sourceLanguage = normalizeTranslatorLanguage(detectedLanguage.code);
    let translated = original;

    if (sourceLanguage && sourceLanguage !== TARGET_LANGUAGE) {
      translated = await translateToEnglish(original, sourceLanguage, onStatus);
    } else if (sourceLanguage === TARGET_LANGUAGE) {
      onStatus("Text is already English");
    } else {
      translated = await translateWithPrompt(original, onStatus);
    }
    onPartial({
      original,
      detectedLanguage,
      translated,
      corrected: translated,
      refined: mode === "translate" ? translated : "",
      mode,
      tone,
      improveAvailable: mode === "translate",
      improveMessage: mode === "translate" ? "Done" : "Translation ready. Refining..."
    });

    if (mode === "translate") {
      const result = {
        original,
        detectedLanguage,
        translated,
        corrected: translated,
        refined: translated,
        mode,
        tone,
        improveAvailable: true,
        improveMessage: "Done"
      };
      rememberPipelineResult(cacheKey, result);
      return result;
    }

    const improved = await tryImproveText(original, translated, detectedLanguage, tone, onStatus);

    const result = {
      original,
      detectedLanguage,
      translated,
      corrected: improved.corrected,
      refined: improved.refined,
      mode,
      tone,
      improveAvailable: improved.available,
      improveMessage: improved.message
    };
    onPartial(result);
    if (canUseCache) {
      rememberPipelineResult(cacheKey, result);
    }
    return result;
  }

  function rememberPipelineResult(key, result) {
    pipelineCache.set(key, result);
    if (pipelineCache.size > 30) {
      const oldestKey = pipelineCache.keys().next().value;
      pipelineCache.delete(oldestKey);
    }
  }

  async function detectLanguage(text, onStatus) {
    onStatus("Detecting language");

    if ("LanguageDetector" in globalThis) {
      const availability = await safeAvailability(LanguageDetector);
      if (availability !== "unavailable") {
        try {
          const detector = await getLanguageDetector();
          const results = await withDeadline(
            detector.detect(text),
            DETECT_TIMEOUT_MS,
            "Detecting the language took too long."
          );

          const best = results?.[0];
          if (best?.detectedLanguage && best.confidence >= MIN_LANGUAGE_CONFIDENCE) {
            return toLanguageResult(best.detectedLanguage, best.confidence, "Language Detector API");
          }
        } catch {
          // Fall through to the local Prompt API when the detector is unavailable in this context.
        }
      }
    }

    const promptCode = await detectLanguageWithPrompt(text, onStatus);
    return promptCode
      ? toLanguageResult(promptCode, null, "Prompt API")
      : toLanguageResult("unknown", null, "Unavailable");
  }

  async function translateToEnglish(text, sourceLanguage, onStatus) {
    onStatus("Translating to English");

    if ("Translator" in globalThis) {
      const options = { sourceLanguage, targetLanguage: TARGET_LANGUAGE };
      const availability = await safeAvailability(Translator, options);

      if (availability !== "unavailable") {
        try {
          const translator = await getTranslator(options);
          const translated = await withDeadline(
            translator.translate(text),
            TRANSLATE_TIMEOUT_MS,
            "Translating took too long."
          );
          return normalizeModelText(translated);
        } catch (error) {
          if (error?.name === "QuickTranslateSetupError") {
            throw error;
          }
          forgetIfCurrent(translatorPromises, translatorKey(options), translatorPromises.get(translatorKey(options)));
          // Fall through to legacy or Prompt API paths.
        }
      }
    }

    const legacy = await runLegacyAi("translator", {
      model: "gemini-nano",
      input: text,
      sourceLanguage,
      targetLanguage: TARGET_LANGUAGE
    });

    if (legacy) {
      return normalizeModelText(legacy);
    }

    return translateWithPrompt(text, onStatus, sourceLanguage);
  }

  async function proofreadEnglish(text, onStatus) {
    onStatus("Fixing grammar");

    if ("Proofreader" in globalThis) {
      const options = { expectedInputLanguages: [TARGET_LANGUAGE] };
      const availability = await safeAvailability(Proofreader, options);

      if (availability !== "unavailable") {
        try {
          const proofreader = await getProofreader(options);
          const result = await proofreader.proofread(text);
          return normalizeModelText(result?.correctedInput || result?.correction || text);
        } catch {
          proofreaderPromise = null;
          // Fall through to legacy or Prompt API paths.
        }
      }
    }

    const legacy = await runLegacyAi("proofreader", {
      model: "gemini-nano",
      input: text
    });

    if (legacy) {
      return normalizeModelText(legacy?.correctedInput || legacy);
    }

    return promptForText(
      "You are a precise English proofreader. Return only the corrected text.",
      `Correct grammar, spelling, and punctuation without changing meaning:\n\n${text}`,
      onStatus
    );
  }

  async function rewriteEnglish(text, tone, onStatus, timeoutMs = FAST_REFINE_TIMEOUT_MS) {
    onStatus(`Refining tone: ${toneLabel(tone)}`);

    if ("Rewriter" in globalThis) {
      const options = {
        tone: tone === "professional" ? "more-formal" : "more-casual",
        format: "plain-text",
        length: "as-is",
        expectedInputLanguages: [TARGET_LANGUAGE],
        expectedContextLanguages: [TARGET_LANGUAGE],
        outputLanguage: TARGET_LANGUAGE,
        sharedContext: "Correct grammar and rewrite the text clearly for everyday written communication."
      };
      const availability = await safeAvailability(Rewriter, options);

      if (availability !== "unavailable") {
        try {
          const rewriter = await getRewriter(tone, options);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          const result = await withDeadline(
            rewriter.rewrite(text, {
              context: `${toneInstruction(tone)} Correct grammar, keep the meaning intact, and avoid returning the original wording unchanged.`,
              signal: controller.signal
            }),
            timeoutMs,
            "Refining took too long. The translation above is ready."
          ).finally(() => clearTimeout(timeout));
          return normalizeModelText(result);
        } catch (error) {
          if (error?.name === "QuickTranslateSetupError") {
            throw error;
          }
          forgetIfCurrent(rewriterPromises, tone, rewriterPromises.get(tone));
          // Fall through to legacy or Prompt API paths.
        }
      }
    }

    const legacy = await runLegacyAi("rewriter", {
      model: "gemini-nano",
      input: text,
      tone
    });

    if (legacy) {
      return normalizeModelText(legacy);
    }

    throw new Error("Chrome Rewriter API is unavailable on this device.");
  }

  async function improveWithPrompt(original, translated, detectedLanguage, tone, onStatus) {
    onStatus(`Refining translation: ${toneLabel(tone)}`);

    return promptForText(
      "You are a professional translator and editor. Return only the final English text, with no explanation.",
      [
        `Translate this ${detectedLanguage.label} text into natural English.`,
        "Fix grammar and wording so the English makes sense.",
        toneInstruction(tone),
        "Preserve the original meaning. Do not add facts.",
        "Do not return the literal translation unchanged. Improve sentence flow and word choice.",
        "",
        `Original text:\n${original}`,
        "",
        `Literal translation to improve:\n${translated}`
      ].join("\n"),
      onStatus,
      {
        timeoutMs: PROMPT_REFINE_TIMEOUT_MS,
        progressLabel: `Refining translation: ${toneLabel(tone)}`
      }
    );
  }

  function improvementUnavailable(message) {
    return {
      available: false,
      corrected: "",
      refined: "",
      message
    };
  }

  // "Refinement unavailable in this Chrome setup." must only appear when that is actually true.
  function refineFailureMessage(error) {
    if (error?.name === "QuickTranslateSetupError") {
      return error.message;
    }
    if (error?.name === "QuickTranslateTimeout") {
      return "Refining took too long. The translation above is ready.";
    }
    if (error?.name === "AbortError") {
      return "Stopped. The translation above is ready.";
    }
    return null;
  }

  async function tryImproveText(original, translated, detectedLanguage, tone, onStatus) {
    if (original.length + translated.length > MAX_PROMPT_REFINE_CHARS) {
      return improvementUnavailable("Text is too long to refine. The translation above is ready.");
    }

    let reported = null;

    try {
      const refined = await improveWithPrompt(original, translated, detectedLanguage, tone, onStatus);
      if (isMeaningfullyDifferent(refined, translated)) {
        return {
          available: true,
          corrected: translated,
          refined,
          message: "Done"
        };
      }
    } catch (error) {
      reported = refineFailureMessage(error);
      if (reported) {
        return improvementUnavailable(reported);
      }
    }

    try {
      const refined = await rewriteEnglish(translated, tone, onStatus);
      if (isMeaningfullyDifferent(refined, translated)) {
        return {
          available: true,
          corrected: translated,
          refined,
          message: "Done"
        };
      }
    } catch (error) {
      reported = refineFailureMessage(error) || reported;
    }

    return improvementUnavailable(reported || "Refinement unavailable in this Chrome setup.");
  }

  async function detectLanguageWithPrompt(text, onStatus) {
    if (!("LanguageModel" in globalThis)) {
      return null;
    }

    try {
      const raw = await promptForText(
        "You detect languages. Return only one BCP 47 language code, such as es, fr, de, ja, zh, or en.",
        `Detect the language of this text:\n\n${text}`,
        onStatus
      );
      return extractLanguageCode(raw);
    } catch {
      return null;
    }
  }

  async function translateWithPrompt(text, onStatus, sourceLanguage = "auto") {
    return promptForText(
      "You translate text into natural English. Return only the English translation.",
      `Translate this ${sourceLanguage === "auto" ? "" : languageLabel(sourceLanguage)} text to English:\n\n${text}`,
      onStatus
    );
  }

  async function promptForText(systemPrompt, userPrompt, onStatus, options = {}) {
    if (!("LanguageModel" in globalThis)) {
      throw new Error("Chrome Prompt API is not available. Enable Built-in AI and reload the extension.");
    }

    const availability = await safeAvailability(LanguageModel, PROMPT_MODEL_OPTIONS);
    if (availability === "unavailable") {
      throw new Error("Chrome Prompt API is unavailable on this device.");
    }

    // getPromptSession() can take minutes on a cold profile; it is bounded by the create
    // watchdog, not by the generation deadline below.
    const session = await getPromptSession(systemPrompt);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const stopTicker = options.progressLabel ? startElapsedTicker(options.progressLabel) : () => {};
    activeCancel = cancel;

    try {
      const result = await withDeadline(
        session.prompt(userPrompt, { signal: controller.signal }),
        options.timeoutMs || PROMPT_TIMEOUT_MS,
        "Refining took too long. The translation above is ready."
      );
      return normalizeModelText(result);
    } catch (error) {
      // Never await the cached entry here: if it is the hung promise, the error path would
      // hang too. Drop it without blocking, and only if it is still the current one.
      const entry = promptSessionPromises.get(systemPrompt);
      if (entry) {
        entry.then((cached) => cached?.destroy?.(), () => {});
        forgetIfCurrent(promptSessionPromises, systemPrompt, entry);
      }
      throw error;
    } finally {
      stopTicker();
      if (activeCancel === cancel) {
        activeCancel = null;
      }
    }
  }

  function getLanguageDetector() {
    if (!detectorPromise) {
      const pending = createModel(LanguageDetector, {}, "language detector").catch((error) => {
        if (detectorPromise === pending) {
          detectorPromise = null;
        }
        throw error;
      });
      detectorPromise = pending;
    }

    return detectorPromise;
  }

  function translationPackLabel(options) {
    return `${languageLabel(options.sourceLanguage)} to English translation pack`;
  }

  function getTranslator(options) {
    const key = translatorKey(options);

    if (!translatorPromises.has(key)) {
      const pending = createModel(Translator, options, translationPackLabel(options)).catch((error) => {
        forgetIfCurrent(translatorPromises, key, pending);
        throw error;
      });
      translatorPromises.set(key, pending);
    }

    return translatorPromises.get(key);
  }

  function translatorKey(options) {
    return `${options.sourceLanguage}:${options.targetLanguage}`;
  }

  function getProofreader(options) {
    if (!proofreaderPromise) {
      const pending = createModel(Proofreader, options, "proofreading model").catch((error) => {
        if (proofreaderPromise === pending) {
          proofreaderPromise = null;
        }
        throw error;
      });
      proofreaderPromise = pending;
    }

    return proofreaderPromise;
  }

  function getRewriter(tone, options) {
    if (!rewriterPromises.has(tone)) {
      const pending = createModel(Rewriter, options, "rewriting model").catch((error) => {
        forgetIfCurrent(rewriterPromises, tone, pending);
        throw error;
      });
      rewriterPromises.set(tone, pending);
    }

    return rewriterPromises.get(tone);
  }

  function getPromptSession(systemPrompt) {
    if (!promptSessionPromises.has(systemPrompt)) {
      const pending = createModel(
        LanguageModel,
        {
          ...PROMPT_MODEL_OPTIONS,
          initialPrompts: [{ role: "system", content: systemPrompt }]
        },
        "on-device language model (about 2 GB)"
      ).catch((error) => {
        forgetIfCurrent(promptSessionPromises, systemPrompt, pending);
        throw error;
      });
      promptSessionPromises.set(systemPrompt, pending);
    }

    return promptSessionPromises.get(systemPrompt);
  }

  function modeLabel(mode) {
    return MODE_OPTIONS.find((option) => option.value === mode)?.label || "Translate";
  }

  function isImproveMode(mode) {
    return mode === "improve";
  }

  function outputText(result) {
    return result?.refined || result?.translated || "";
  }

  function refinedDisplayText(result) {
    if (result?.refined) {
      return result.refined;
    }

    if (result?.improveAvailable === false) {
      return result.improveMessage || "Refinement unavailable in this Chrome setup.";
    }

    return "Refining...";
  }

  async function runLegacyAi(kind, payload) {
    const api = chrome?.ai?.[kind] || globalThis.ai?.[kind];
    if (!api?.run) {
      return null;
    }

    try {
      return await api.run(payload);
    } catch {
      return null;
    }
  }

  async function safeAvailability(factory, options) {
    if (!factory?.availability) {
      return "available";
    }

    // A timeout must not read as "unavailable": that would skip the guarded create() that
    // knows how to ask for a gesture. Throwing still means unavailable, as before.
    const ask = async (opts) => {
      let timer = null;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve("downloadable"), AVAILABILITY_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          opts ? factory.availability(opts) : factory.availability(),
          timedOut
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await ask(options);
    } catch {
      try {
        return await ask(null);
      } catch {
        return "unavailable";
      }
    }
  }

  // event.loaded is a 0..1 fraction and event.total is always 1, so this reports a percentage
  // rather than the "0.5/1" that loaded/total would produce. No events fire when the model is
  // already available, so absence of progress is never treated as an error.
  function createDownloadMonitor(label, onProgress = () => {}) {
    return (monitorTarget) => {
      monitorTarget.addEventListener("downloadprogress", (event) => {
        onProgress();
        const fraction = Number(event?.loaded);
        if (!Number.isFinite(fraction)) {
          return;
        }
        const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
        statusSink(`Downloading ${label}: ${percent}%`);
      });
    };
  }

  function normalizeTranslatorLanguage(code) {
    if (!code || code === "unknown") {
      return null;
    }

    const normalized = code.toLowerCase();
    if (normalized === "he") {
      return "iw";
    }
    if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-hant") {
      return "zh-Hant";
    }
    if (normalized.startsWith("zh")) {
      return "zh";
    }

    const base = normalized.split("-")[0];
    return TRANSLATOR_LANGUAGES.has(base) ? base : null;
  }

  function toLanguageResult(code, confidence, source) {
    const normalized = code || "unknown";
    return {
      code: normalized,
      label: normalized === "unknown" ? "Unknown" : languageLabel(normalized),
      confidence,
      source
    };
  }

  function languageLabel(code) {
    if (!code || code === "unknown") {
      return "Unknown";
    }

    try {
      return languageNames?.of(code) || code;
    } catch {
      return code;
    }
  }

  function toneLabel(tone) {
    return TONE_OPTIONS.find((option) => option.value === tone)?.label || "Professional";
  }

  function toneInstruction(tone) {
    if (tone === "casual") {
      return "Use a casual tone: relaxed, conversational, simple, and natural. Use everyday phrasing and contractions where they fit.";
    }

    if (tone === "friendly") {
      return "Use a friendly tone: warm, approachable, clear, and positive. Make the wording sound helpful and personable.";
    }

    return "Use a professional tone: polished, clear, formal, and concise. Avoid slang and keep the wording suitable for school or workplace writing.";
  }

  function normalizeModelText(value) {
    return String(value ?? "")
      .replace(/^```(?:text|markdown)?/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  function normalizeForComparison(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMeaningfullyDifferent(candidate, source) {
    const normalizedCandidate = normalizeForComparison(candidate);
    const normalizedSource = normalizeForComparison(source);
    return Boolean(normalizedCandidate)
      && normalizedCandidate !== normalizedSource;
  }

  function extractLanguageCode(text) {
    const cleaned = String(text || "").toLowerCase();
    const match = cleaned.match(/\b[a-z]{2,3}(?:-[a-z0-9]{2,8})?\b/i);
    return match ? match[0] : null;
  }

  function captureEditableTarget(selectedText) {
    const active = document.activeElement;

    if (isTextInput(active)) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
        return {
          type: "input",
          element: active,
          start,
          end
        };
      }
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const editable = closestEditable(range.commonAncestorContainer);
    if (!editable) {
      return null;
    }

    if (selectedText && selection.toString().trim() !== selectedText.trim()) {
      return null;
    }

    return {
      type: "contenteditable",
      element: editable,
      range: range.cloneRange()
    };
  }

  function isTextInput(element) {
    if (!element) {
      return false;
    }

    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    return [
      "email",
      "search",
      "text",
      "url"
    ].includes(element.type);
  }

  function closestEditable(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const editable = element?.closest?.("[contenteditable]") || null;
    return editable?.getAttribute("contenteditable") === "false" ? null : editable;
  }

  function replaceEditableText(target, value) {
    if (!target) {
      throw new Error("The original selection is not inside an editable field.");
    }

    if (target.type === "input") {
      target.element.focus();
      target.element.setSelectionRange(target.start, target.end);
      target.element.setRangeText(value, target.start, target.end, "end");
      target.element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: value
      }));
      target.element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    target.element.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(target.range);
    target.range.deleteContents();
    const inserted = document.createTextNode(value);
    target.range.insertNode(inserted);
    target.range.setStartAfter(inserted);
    target.range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(target.range);
    target.element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: value
    }));
  }

  async function runSelection(text, tone, mode = "translate") {
    const runId = ++activeRunId;
    lastEditableTarget = captureEditableTarget(text);
    lastResult = null;

    const panel = getPanel();
    panel.setLoading({
      original: text,
      mode,
      tone,
      canReplace: Boolean(lastEditableTarget),
      status: "Starting"
    });

    try {
      const result = await runPipeline(text, tone, (status) => {
        if (runId === activeRunId) {
          panel.updateStatus(status);
        }
      }, {
        mode,
        onNeedsGesture({ label, proceed }) {
          if (runId !== activeRunId) {
            return;
          }

          panel.renderSetup({ label, proceed, original: text, mode, tone });
        },
        onPartial(partial) {
          if (runId !== activeRunId || !partial.translated) {
            return;
          }

          lastResult = partial;
          panel.renderResult(partial, {
            canReplace: Boolean(lastEditableTarget),
            busy: true
          });
        }
      });

      if (runId !== activeRunId) {
        return;
      }

      lastResult = result;
      panel.renderResult(result, {
        canReplace: Boolean(lastEditableTarget),
        busy: false
      });
    } catch (error) {
      if (runId === activeRunId) {
        panel.renderError(error);
      }
    }
  }

  // Makes the raised refine budget acceptable: the user always has an escape hatch.
  function cancelActiveRun() {
    activeRunId += 1;
    if (activeCancel) {
      activeCancel();
      activeCancel = null;
    }

    if (!panelController) {
      return;
    }

    if (lastResult?.translated) {
      const stopped = {
        ...lastResult,
        refined: "",
        improveAvailable: false,
        improveMessage: "Stopped. The translation above is ready."
      };
      lastResult = stopped;
      panelController.renderResult(stopped, {
        canReplace: Boolean(lastEditableTarget),
        busy: false
      });
      return;
    }

    panelController.updateStatus("Stopped.");
  }

  function getPanel() {
    if (panelController) {
      return panelController;
    }

    const host = document.createElement("div");
    host.id = PANEL_ID;
    document.documentElement.append(host);
    panelController = createPanelController(host);
    return panelController;
  }

  function makePanelDraggable(host, handle, excludedElement) {
    let dragState = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || excludedElement.contains(event.target)) {
        return;
      }

      const rect = host.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragState) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - 48);
      const nextLeft = clamp(event.clientX - dragState.offsetX, 8, maxLeft);
      const nextTop = clamp(event.clientY - dragState.offsetY, 8, maxTop);

      host.style.setProperty("--qt-panel-left", `${nextLeft}px`);
      host.style.setProperty("--qt-panel-right", "auto");
      host.style.setProperty("--qt-panel-top", `${nextTop}px`);
    });

    handle.addEventListener("pointerup", (event) => {
      dragState = null;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    });

    handle.addEventListener("pointercancel", () => {
      dragState = null;
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createPanelController(host) {
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        color-scheme: light;
        position: fixed;
        left: var(--qt-panel-left, auto);
        right: var(--qt-panel-right, 20px);
        top: var(--qt-panel-top, 20px);
        z-index: 2147483647;
        width: min(380px, calc(100vw - 32px));
        max-height: calc(100vh - 40px);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .panel {
        background: #fbfbf8;
        border: 1px solid #d8d5cc;
        border-radius: 8px;
        box-shadow: 0 18px 50px rgba(35, 38, 35, 0.24);
        color: #242722;
        overflow: hidden;
      }

      .header,
      .toolbar {
        align-items: center;
        display: flex;
        gap: 8px;
      }

      .header {
        background: #f0efe8;
        border-bottom: 1px solid #d8d5cc;
        cursor: move;
        justify-content: space-between;
        padding: 10px 12px;
        user-select: none;
      }

      .title {
        font-size: 14px;
        font-weight: 700;
      }

      .icon-button,
      .primary-button,
      select {
        border: 1px solid #bbb7aa;
        border-radius: 6px;
        font: inherit;
      }

      .icon-button {
        align-items: center;
        background: #fff;
        color: #383b35;
        cursor: pointer;
        display: inline-flex;
        height: 30px;
        justify-content: center;
        width: 30px;
      }

      .icon-button:hover {
        background: #ecebe4;
      }

      .body {
        display: grid;
        gap: 10px;
        max-height: calc(100vh - 102px);
        overflow: auto;
        padding: 12px;
      }

      .toolbar {
        flex-wrap: wrap;
      }

      select {
        background: #fff;
        color: #242722;
        min-height: 32px;
        padding: 0 8px;
      }

      .primary-button {
        background: #215f53;
        color: #fff;
        cursor: pointer;
        min-height: 32px;
        padding: 0 10px;
      }

      .primary-button:disabled {
        background: #b6b3a9;
        color: #5f5c55;
        cursor: not-allowed;
      }

      .status {
        background: #e7efe9;
        border: 1px solid #bfd3c5;
        border-radius: 6px;
        color: #25443a;
        font-size: 12px;
        line-height: 1.4;
        padding: 8px;
      }

      .section {
        border-top: 1px solid #e4e1d8;
        padding-top: 9px;
      }

      .section:first-of-type {
        border-top: 0;
        padding-top: 0;
      }

      .label {
        color: #5c5f58;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .text {
        font-size: 13px;
        line-height: 1.48;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .error {
        background: #fff0ee;
        border-color: #e2b8b0;
        color: #7a281f;
      }
    `;

    const panel = document.createElement("section");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "AI Translator";
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.title = "Close";
    close.textContent = "x";
    close.addEventListener("click", () => {
      host.remove();
      panelController = null;
    });
    header.append(title, close);
    makePanelDraggable(host, header, close);

    const body = document.createElement("div");
    body.className = "body";
    panel.append(header, body);
    root.append(style, panel);

    function updateStatus(status) {
      const statusElement = body.querySelector("[data-status]");
      if (statusElement) {
        statusElement.textContent = status;
      }
    }

    function setLoading({ original, mode, tone, canReplace, status }) {
      body.replaceChildren();
      body.append(createToolbar(mode, tone, canReplace, true));
      body.append(createStatus(status));
      body.append(createSection("Original", original));
    }

    function renderResult(result, { canReplace, busy = false }) {
      body.replaceChildren();
      body.append(createToolbar(result.mode, result.tone, canReplace, busy));
      body.append(createStatus(result.improveMessage || "Done"));
      body.append(createSection("Detected Language", languageSummary(result.detectedLanguage)));
      body.append(createSection("Original", result.original));
      body.append(createSection("Translated", result.translated));
      if (isImproveMode(result.mode)) {
        body.append(createSection("Refined", refinedDisplayText(result)));
      }
    }

    // The status node carries data-status, so download percentages land in this same card.
    function renderSetup({ label, proceed, original, mode, tone }) {
      body.replaceChildren();
      body.append(createToolbar(mode, tone, false, true));
      body.append(createStatus(
        `One-time setup needed. Chrome must download the ${label} before this can run. It downloads once, stays on your device, and nothing you translate is ever sent to a server.`
      ));

      const row = document.createElement("div");
      row.className = "toolbar";
      const go = document.createElement("button");
      go.className = "primary-button";
      go.type = "button";
      go.textContent = "Download & Continue";
      go.addEventListener("click", () => {
        row.remove();
        updateStatus("Starting download...");
        proceed();
      });
      row.append(go);
      body.append(row);
      body.append(createSection("Original", original));
    }

    function renderError(error) {
      body.replaceChildren();
      body.append(createStatus(error?.message || String(error), "error"));
    }

    function createToolbar(mode, tone, canReplace, busy) {
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";

      const modeSelect = document.createElement("select");
      modeSelect.title = "Mode";
      for (const option of MODE_OPTIONS) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        item.selected = option.value === mode;
        modeSelect.append(item);
      }
      modeSelect.disabled = busy;
      modeSelect.addEventListener("change", async () => {
        if (lastResult) {
          runSelection(lastResult.original, toneSelect.value, modeSelect.value);
        }
      });

      const toneSelect = document.createElement("select");
      toneSelect.title = "Tone";
      for (const option of TONE_OPTIONS) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        item.selected = option.value === tone;
        toneSelect.append(item);
      }
      toneSelect.disabled = busy || !isImproveMode(mode);
      toneSelect.addEventListener("change", async () => {
        await chrome.storage.sync.set({ tone: toneSelect.value });
        if (lastResult) {
          runSelection(lastResult.original, toneSelect.value, modeSelect.value);
        }
      });

      const copy = document.createElement("button");
      copy.className = "primary-button";
      copy.type = "button";
      copy.textContent = "Copy";
      copy.disabled = busy || !outputText(lastResult);
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(outputText(lastResult));
        updateStatus("Copied output text");
      });

      const replace = document.createElement("button");
      replace.className = "primary-button";
      replace.type = "button";
      replace.textContent = "Replace";
      replace.disabled = busy || !canReplace || !outputText(lastResult);
      replace.title = canReplace
        ? "Replace selected editable text"
        : "Select text inside an input or editor to replace it";
      replace.addEventListener("click", () => {
        replaceEditableText(lastEditableTarget, outputText(lastResult));
        updateStatus("Replaced selected text");
      });

      toolbar.append(modeSelect, toneSelect);

      if (isImproveMode(mode)) {
        const refineAgain = document.createElement("button");
        refineAgain.className = "primary-button";
        refineAgain.type = "button";
        refineAgain.textContent = "Refine Again";
        refineAgain.disabled = busy || !lastResult?.original;
        refineAgain.addEventListener("click", () => {
          runSelection(lastResult.original, toneSelect.value, "improve");
        });
        toolbar.append(refineAgain);
      }

      if (busy) {
        const stop = document.createElement("button");
        stop.className = "primary-button";
        stop.type = "button";
        stop.textContent = "Stop";
        stop.title = "Stop and keep the translation";
        stop.addEventListener("click", () => {
          cancelActiveRun();
        });
        toolbar.append(stop);
      }

      toolbar.append(copy, replace);
      return toolbar;
    }

    return {
      setLoading,
      updateStatus,
      renderResult,
      renderSetup,
      renderError
    };
  }

  function createStatus(text, extraClass = "") {
    const status = document.createElement("div");
    status.className = `status ${extraClass}`.trim();
    status.dataset.status = "true";
    status.textContent = text;
    return status;
  }

  function createSection(label, value) {
    const section = document.createElement("div");
    section.className = "section";
    const sectionLabel = document.createElement("div");
    sectionLabel.className = "label";
    sectionLabel.textContent = label;
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = value || "";
    section.append(sectionLabel, text);
    return section;
  }

  function languageSummary(language) {
    if (!language) {
      return "Unknown";
    }

    return language.label;
  }

  if (!IS_EXTENSION_PAGE) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== MSG_RUN_SELECTION) {
        return undefined;
      }

      sendResponse({ ok: true });
      runSelection(message.text, message.tone || "professional", message.mode || "translate");
      return undefined;
    });
  }

  globalThis.quickTranslateAI = {
    runPipeline,
    modes: MODE_OPTIONS,
    modeLabel,
    tones: TONE_OPTIONS,
    toneLabel
  };
})();
