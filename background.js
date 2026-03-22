// background.js

let lastVisibleCaptureAt = 0;
const popupWriterWaiters = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "POPUP_CLIPBOARD_WRITER_READY") {
    return undefined;
  }

  const waiter = popupWriterWaiters.get(message.requestId);
  if (waiter) {
    clearTimeout(waiter.timeoutId);
    popupWriterWaiters.delete(message.requestId);
    waiter.resolve({
      tabId: sender.tab?.id,
      windowId: sender.tab?.windowId
    });
  }

  sendResponse({ success: true });
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot") {
    captureFullPage();
  }
});

// Icon click — tab already has focus, no popup in the way
chrome.action.onClicked.addListener((tab) => {
  captureFullPage();
});

async function captureFullPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");

  const tabId = tab.id;

  try {
    const captureState = await preparePageForCapture(tabId);

    try {
      const slices = await captureVisibleTabSlices(tab.windowId, tabId, captureState);
      await writeSlicesToClipboard(tabId, captureState.widthPx, captureState.heightPx, slices);
    } finally {
      await restorePageAfterCapture(tabId).catch(() => {});
    }

    chrome.action.setBadgeText({ text: "✓", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);

  } catch (err) {
    chrome.action.setBadgeText({ text: "✗", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 3000);
    throw err;
  }
}

async function preparePageForCapture(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const HIDDEN_ATTR = "data-full-page-capture-hidden";
      const STYLE_ID = "__full_page_capture_style__";
      const STATE_KEY = "__fullPageCaptureState";

      const fixedOrStickyElements = Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const position = window.getComputedStyle(element).position;
          return position === "fixed" || position === "sticky";
        });

      for (const element of fixedOrStickyElements) {
        element.setAttribute(HIDDEN_ATTR, "false");
      }

      let styleElement = document.getElementById(STYLE_ID);
      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = STYLE_ID;
        styleElement.textContent = `
          html { scroll-behavior: auto !important; }
          * { animation: none !important; transition: none !important; }
          [${HIDDEN_ATTR}="true"] { visibility: hidden !important; }
        `;
        document.documentElement.appendChild(styleElement);
      }

      window[STATE_KEY] = {
        scrollX: window.scrollX,
        scrollY: window.scrollY
      };

      window.scrollTo(0, 0);

      const fullHeightCss = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        document.documentElement.offsetHeight,
        document.body?.offsetHeight || 0,
        document.documentElement.clientHeight
      );

      const viewportHeightCss = window.innerHeight;
      const viewportWidthCss = document.documentElement.clientWidth;
      const dpr = window.devicePixelRatio || 1;

      return {
        fullHeightCss,
        viewportHeightCss,
        viewportWidthCss,
        dpr,
        widthPx: Math.round(viewportWidthCss * dpr),
        heightPx: Math.round(fullHeightCss * dpr)
      };
    }
  });

  return results[0].result;
}

async function captureVisibleTabSlices(windowId, tabId, captureState) {
  const {
    fullHeightCss,
    viewportHeightCss,
    dpr
  } = captureState;

  const positions = buildCapturePositions(fullHeightCss, viewportHeightCss);
  const slices = [];
  let stitchedUntilCss = 0;

  for (const positionCss of positions) {
    await setPageScrollPosition(tabId, positionCss, positionCss > 0);
    await delay(200);

    const dataUrl = await captureVisibleTabThrottled(windowId);

    const visibleBottomCss = Math.min(positionCss + viewportHeightCss, fullHeightCss);
    const uncapturedTopCss = Math.max(positionCss, stitchedUntilCss);
    const drawHeightCss = visibleBottomCss - uncapturedTopCss;

    if (drawHeightCss <= 0) {
      continue;
    }

    slices.push({
      destYPx: Math.round(uncapturedTopCss * dpr),
      sourceYPx: Math.round((uncapturedTopCss - positionCss) * dpr),
      heightPx: Math.round(drawHeightCss * dpr),
      base64Data: dataUrlToBase64(dataUrl)
    });

    stitchedUntilCss = visibleBottomCss;
  }

  return slices;
}

async function writeSlicesToClipboard(tabId, width, height, slices) {
  if (await canUseOffscreenClipboard()) {
    try {
      await ensureOffscreenDocument();
      await writeSlicesToClipboardViaOffscreenDocument(width, height, slices);
      return;
    } catch (error) {
      if (!isFocusRelatedClipboardError(error)) {
        throw error;
      }
    }
  }

  try {
    await writeSlicesToClipboardViaPopupWindow(width, height, slices);
    return;
  } catch (error) {
    if (!isFocusRelatedClipboardError(error)) {
      throw error;
    }
  }

  await focusTab(tabId);
  await writeSlicesToClipboardViaTab(tabId, width, height, slices);
}

async function writeToClipboard(tabId, base64Data) {
  if (await canUseOffscreenClipboard()) {
    try {
      await ensureOffscreenDocument();
      await writeToClipboardViaOffscreenDocument(base64Data);
      return;
    } catch (error) {
      if (!isFocusRelatedClipboardError(error)) {
        throw error;
      }
    }
  }

  try {
    await writeToClipboardViaPopupWindow(base64Data);
    return;
  } catch (error) {
    if (!isFocusRelatedClipboardError(error)) {
      throw error;
    }
  }

  await focusTab(tabId);
  await writeToClipboardViaTab(tabId, base64Data);
}

async function canUseOffscreenClipboard() {
  return Boolean(chrome.offscreen?.createDocument);
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Write captured screenshots to the clipboard."
    });
  } catch (error) {
    if (!error.message?.includes("Only a single offscreen")) {
      throw error;
    }
  }
}

async function writeToClipboardViaOffscreenDocument(base64Data) {
  const response = await sendOffscreenMessage({
    type: "WRITE_IMAGE_TO_CLIPBOARD",
    base64Data
  });

  if (!response?.success) {
    throw new Error(response?.error || "Clipboard write failed in offscreen document");
  }
}

async function writeSlicesToClipboardViaOffscreenDocument(width, height, slices) {
  let response = await sendOffscreenMessage({
    type: "INIT_STITCHED_IMAGE",
    width,
    height
  });

  if (!response?.success) {
    throw new Error(response?.error || "Failed to initialize stitched image");
  }

  for (const slice of slices) {
    response = await sendOffscreenMessage({
      type: "APPEND_IMAGE_SLICE",
      destYPx: slice.destYPx,
      sourceYPx: slice.sourceYPx,
      heightPx: slice.heightPx,
      base64Data: slice.base64Data
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to append image slice");
    }
  }

  response = await sendOffscreenMessage({
    type: "WRITE_STITCHED_IMAGE_TO_CLIPBOARD"
  });

  if (!response?.success) {
    throw new Error(response?.error || "Failed to write stitched image to clipboard");
  }
}

async function writeToClipboardViaPopupWindow(base64Data) {
  const popupSession = await openPopupClipboardWriter();

  try {
    const response = await sendPopupWriterMessage({
      type: "WRITE_IMAGE_TO_CLIPBOARD_IN_POPUP",
      requestId: popupSession.requestId,
      base64Data
    });

    if (!response?.success) {
      throw new Error(response?.error || "Clipboard write failed in popup window");
    }
  } finally {
    await closePopupClipboardWriter(popupSession.windowId);
  }
}

async function writeSlicesToClipboardViaPopupWindow(width, height, slices) {
  const popupSession = await openPopupClipboardWriter();

  try {
    let response = await sendPopupWriterMessage({
      type: "INIT_STITCHED_IMAGE_IN_POPUP",
      requestId: popupSession.requestId,
      width,
      height
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to initialize popup stitched image");
    }

    for (const slice of slices) {
      response = await sendPopupWriterMessage({
        type: "APPEND_IMAGE_SLICE_IN_POPUP",
        requestId: popupSession.requestId,
        destYPx: slice.destYPx,
        sourceYPx: slice.sourceYPx,
        heightPx: slice.heightPx,
        base64Data: slice.base64Data
      });

      if (!response?.success) {
        throw new Error(response?.error || "Failed to append popup image slice");
      }
    }

    response = await sendPopupWriterMessage({
      type: "WRITE_STITCHED_IMAGE_TO_CLIPBOARD_IN_POPUP",
      requestId: popupSession.requestId
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to write popup stitched image to clipboard");
    }
  } finally {
    await closePopupClipboardWriter(popupSession.windowId);
  }
}

function sendOffscreenMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function openPopupClipboardWriter() {
  const requestId = crypto.randomUUID();
  const readyPromise = waitForPopupClipboardWriter(requestId);
  const popupUrl = chrome.runtime.getURL(`clipboard.html?requestId=${encodeURIComponent(requestId)}`);
  const popupWindow = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    focused: true,
    width: 360,
    height: 240
  });

  try {
    await readyPromise;
  } catch (error) {
    await closePopupClipboardWriter(popupWindow.id);
    throw error;
  }

  return {
    requestId,
    windowId: popupWindow.id
  };
}

function waitForPopupClipboardWriter(requestId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      popupWriterWaiters.delete(requestId);
      reject(new Error("Popup clipboard writer did not become ready"));
    }, 5000);

    popupWriterWaiters.set(requestId, {
      resolve,
      reject,
      timeoutId
    });
  });
}

function sendPopupWriterMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function closePopupClipboardWriter(windowId) {
  if (windowId == null) {
    return;
  }

  await chrome.windows.remove(windowId).catch(() => {});
}

async function setPageScrollPosition(tabId, y, hideStickyElements) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (nextY, shouldHideStickyElements) => {
      const HIDDEN_ATTR = "data-full-page-capture-hidden";

      for (const element of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
        element.setAttribute(HIDDEN_ATTR, shouldHideStickyElements ? "true" : "false");
      }

      window.scrollTo(0, nextY);
    },
    args: [y, hideStickyElements]
  });
}

async function restorePageAfterCapture(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const HIDDEN_ATTR = "data-full-page-capture-hidden";
      const STYLE_ID = "__full_page_capture_style__";
      const STATE_KEY = "__fullPageCaptureState";

      for (const element of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
        element.removeAttribute(HIDDEN_ATTR);
      }

      document.getElementById(STYLE_ID)?.remove();

      const previousState = window[STATE_KEY];
      if (previousState) {
        window.scrollTo(previousState.scrollX, previousState.scrollY);
        delete window[STATE_KEY];
      }
    }
  });
}

function buildCapturePositions(fullHeightCss, viewportHeightCss) {
  if (fullHeightCss <= viewportHeightCss) {
    return [0];
  }

  const positions = [];
  for (let y = 0; y < fullHeightCss; y += viewportHeightCss) {
    positions.push(y);
  }

  const lastPosition = Math.max(fullHeightCss - viewportHeightCss, 0);
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return [...new Set(positions)];
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.split(",", 2)[1];
}

async function captureVisibleTabThrottled(windowId) {
  const minIntervalMs = 600;
  const elapsedMs = Date.now() - lastVisibleCaptureAt;

  if (elapsedMs < minIntervalMs) {
    await delay(minIntervalMs - elapsedMs);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png"
  });

  lastVisibleCaptureAt = Date.now();
  return dataUrl;
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await delay(150);
}

async function writeToClipboardViaTab(tabId, base64Data) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (b64) => {
      try {
        window.focus();
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (!document.hasFocus()) {
          throw new Error("Document is not focused");
        }

        const byteString = atob(b64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
          bytes[i] = byteString.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: "image/png" });
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    args: [base64Data]
  });

  const result = results?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || "Clipboard write failed in tab");
  }
}

async function writeSlicesToClipboardViaTab(tabId, width, height, slices) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (canvasWidth, canvasHeight, imageSlices) => {
      try {
        window.focus();
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (!document.hasFocus()) {
          throw new Error("Document is not focused");
        }

        const canvas = document.createElement("canvas");
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Failed to create canvas context");
        }

        for (const slice of imageSlices) {
          const image = await loadImage(slice.base64Data);
          context.drawImage(
            image,
            0,
            slice.sourceYPx,
            image.width,
            slice.heightPx,
            0,
            slice.destYPx,
            image.width,
            slice.heightPx
          );
        }

        const blob = await canvasToBlob(canvas);
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]);

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }

      function loadImage(base64Data) {
        return new Promise((resolve, reject) => {
          const image = new Image();

          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Failed to decode image slice"));
          image.src = `data:image/png;base64,${base64Data}`;
        });
      }

      function canvasToBlob(canvasElement) {
        return new Promise((resolve, reject) => {
          canvasElement.toBlob((blob) => {
            if (!blob) {
              reject(new Error("Failed to encode stitched image"));
              return;
            }

            resolve(blob);
          }, "image/png");
        });
      }
    },
    args: [width, height, slices]
  });

  const result = results?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || "Clipboard write failed in tab");
  }
}

function isFocusRelatedClipboardError(error) {
  return error?.message?.includes("Document is not focused");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
