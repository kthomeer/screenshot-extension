let stitchedCanvas = null;
let stitchedContext = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "WRITE_IMAGE_TO_CLIPBOARD":
      await writeImageToClipboard(message.base64Data);
      return;
    case "INIT_STITCHED_IMAGE":
      initStitchedImage(message.width, message.height);
      return;
    case "APPEND_IMAGE_SLICE":
      await appendImageSlice(
        message.destYPx,
        message.sourceYPx,
        message.heightPx,
        message.base64Data
      );
      return;
    case "WRITE_STITCHED_IMAGE_TO_CLIPBOARD":
      await writeStitchedImageToClipboard();
      return;
    default:
      throw new Error(`Unsupported offscreen message type: ${message?.type}`);
  }
}

function initStitchedImage(width, height) {
  stitchedCanvas = document.createElement("canvas");
  stitchedCanvas.width = width;
  stitchedCanvas.height = height;
  stitchedContext = stitchedCanvas.getContext("2d");
}

async function appendImageSlice(destYPx, sourceYPx, heightPx, base64Data) {
  if (!stitchedCanvas || !stitchedContext) {
    throw new Error("Stitched image was not initialized");
  }

  const image = await loadImageFromBase64(base64Data);
  stitchedContext.drawImage(
    image,
    0,
    sourceYPx,
    image.width,
    heightPx,
    0,
    destYPx,
    image.width,
    heightPx
  );
}

async function writeStitchedImageToClipboard() {
  if (!stitchedCanvas) {
    throw new Error("Stitched image was not initialized");
  }

  const blob = await canvasToBlob(stitchedCanvas);
  await writeBlobToClipboard(blob);
  resetStitchedImage();
}

function resetStitchedImage() {
  stitchedCanvas = null;
  stitchedContext = null;
}

async function writeImageToClipboard(base64Data) {
  const byteString = atob(base64Data);
  const bytes = new Uint8Array(byteString.length);

  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "image/png" });
  await writeBlobToClipboard(blob);
}

async function writeBlobToClipboard(blob) {
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob })
  ]);
}

function loadImageFromBase64(base64Data) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image slice"));
    image.src = `data:image/png;base64,${base64Data}`;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode stitched image"));
        return;
      }

      resolve(blob);
    }, "image/png");
  });
}
