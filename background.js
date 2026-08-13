const MENU_TRANSLATE = "quicktranslate.translateSelection";
const MSG_RUN_SELECTION = "quicktranslate.runSelection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE,
      title: "Translate & Improve with AI",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_TRANSLATE || !info.selectionText || !tab?.id) {
    return;
  }

  const { tone = "professional" } = await chrome.storage.sync.get({
    tone: "professional"
  });

  const payload = {
    type: MSG_RUN_SELECTION,
    text: info.selectionText,
    mode: "translate",
    tone
  };

  try {
    await sendToTab(tab.id, payload);
  } catch (error) {
    console.error("AI Translator Assistant could not run on this page.", error);
  }
});

async function sendToTab(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
    return;
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }

  await chrome.tabs.sendMessage(tabId, payload);
}
