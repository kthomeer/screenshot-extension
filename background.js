const CAPTURE_BADGE_SUCCESS_MS = 2000;
const CAPTURE_BADGE_ERROR_MS = 3000;
const activeCaptures = new Set();

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot") {
    void handleCaptureRequest();
  }
});

chrome.action.onClicked.addListener(() => {
  void handleCaptureRequest();
});

async function captureFullPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  validateCapturableTab(tab);

  const tabId = tab.id;
  if (activeCaptures.has(tabId)) {
    throw new Error("A capture is already running for this tab.");
  }

  activeCaptures.add(tabId);

  let debuggerAttached = false;
  let metricsOverridden = false;

  try {
    await attachDebugger(tabId);
    debuggerAttached = true;

    const { cssContentSize } = await sendDebuggerCommand(tabId, "Page.getLayoutMetrics");
    const width = Math.max(1, Math.ceil(cssContentSize.width));
    const height = Math.max(1, Math.ceil(cssContentSize.height));

    await sendDebuggerCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    metricsOverridden = true;

    const screenshot = await sendDebuggerCommand(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });

    await writeToClipboardViaTab(tabId, screenshot.data);
    await setTemporaryBadge(tabId, "OK", "#16a34a", CAPTURE_BADGE_SUCCESS_MS);
  } catch (error) {
    await setTemporaryBadge(tabId, "ERR", "#dc2626", CAPTURE_BADGE_ERROR_MS);
    throw error;
  } finally {
    if (metricsOverridden) {
      await sendDebuggerCommand(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }

    if (debuggerAttached) {
      await detachDebugger(tabId).catch(() => {});
    }

    activeCaptures.delete(tabId);
  }
}

async function handleCaptureRequest() {
  try {
    await captureFullPage();
  } catch (error) {
    console.error("Capture request failed:", error);
  }
}

function validateCapturableTab(tab) {
  const blockedPrefixes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "devtools://"
  ];

  if (blockedPrefixes.some((prefix) => tab.url?.startsWith(prefix))) {
    throw new Error("This page cannot be captured because the browser blocks debugger access.");
  }
}

async function writeToClipboardViaTab(tabId, base64Data) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (b64) => {
      try {
        const byteString = atob(b64);
        const bytes = new Uint8Array(byteString.length);

        for (let index = 0; index < byteString.length; index += 1) {
          bytes[index] = byteString.charCodeAt(index);
        }

        const blob = new Blob([bytes], { type: "image/png" });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    },
    args: [base64Data]
  });

  const result = results?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || "Clipboard write failed in the current tab.");
  }
}

async function setTemporaryBadge(tabId, text, color, timeoutMs) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "", tabId });
  }, timeoutMs);
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function sendDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result);
    });
  });
}
