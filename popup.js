const input = document.getElementById("input");
const tone = document.getElementById("tone");
const run = document.getElementById("run");
const copy = document.getElementById("copy");
const mode = document.getElementById("mode");
const status = document.getElementById("status");
const output = document.getElementById("output");
const error = document.getElementById("error");
const detected = document.getElementById("detected");
const translated = document.getElementById("translated");
const corrected = document.getElementById("corrected");
const correctedSection = document.getElementById("corrected-section");
const refined = document.getElementById("refined");
const refinedSection = document.getElementById("refined-section");

let latestResult = null;

init();

async function init() {
  const settings = await chrome.storage.sync.get({
    tone: "professional"
  });
  mode.value = "translate";
  tone.value = settings.tone;
  syncToneAvailability();

  mode.addEventListener("change", () => {
    syncToneAvailability();
  });

  tone.addEventListener("change", () => {
    chrome.storage.sync.set({ tone: tone.value });
  });

  run.addEventListener("click", runManualPipeline);
  copy.addEventListener("click", copyRefinedText);
}

async function runManualPipeline() {
  const text = input.value.trim();
  if (!text) {
    setError("Enter text first.");
    return;
  }

  setBusy(true);
  clearError();
  output.hidden = true;

  try {
    latestResult = await quickTranslateAI.runPipeline(text, tone.value, setStatus, {
      mode: mode.value,
      onPartial(partial) {
        if (!partial.translated) {
          return;
        }

        latestResult = partial;
        renderResult(partial);
      }
    });
    renderResult(latestResult);
    setStatus(latestResult.improveMessage || "Done");
  } catch (err) {
    setError(err?.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function copyRefinedText() {
  const text = outputText(latestResult);
  if (!text) {
    return;
  }

  await navigator.clipboard.writeText(text);
  setStatus("Copied output text");
}

function renderResult(result) {
  detected.textContent = result.detectedLanguage.label;
  translated.textContent = result.translated;
  correctedSection.hidden = true;
  refinedSection.hidden = result.mode !== "improve";
  corrected.textContent = "";
  refined.textContent = result.mode === "improve"
    ? refinedDisplayText(result)
    : "";
  output.hidden = false;
}

function setStatus(message) {
  status.textContent = message;
}

function setBusy(isBusy) {
  run.disabled = isBusy;
  mode.disabled = isBusy;
  tone.disabled = isBusy || mode.value !== "improve";
  run.textContent = isBusy ? "Running" : "Run";
}

function setError(message) {
  error.textContent = message;
  error.hidden = false;
  setStatus("Error");
}

function clearError() {
  error.textContent = "";
  error.hidden = true;
}

function syncToneAvailability() {
  tone.disabled = mode.value !== "improve";
}

function outputText(result) {
  return result?.refined || result?.translated || "";
}

function refinedDisplayText(result) {
  if (result?.refined) {
    return result.refined;
  }

  if (result?.improveAvailable === false) {
    return "Refinement unavailable in this Chrome setup.";
  }

  return "Refining...";
}
