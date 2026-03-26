# Full Page Screenshot to Clipboard

A minimal Chrome extension that captures a **full-page screenshot** of the current tab and copies it directly to your clipboard — no DevTools needed.

## Features

- Captures the entire page, including content below the fold
- Copies the screenshot as a PNG image to your clipboard (ready to paste anywhere)
- Two ways to trigger: keyboard shortcut or toolbar icon click
- No popups, no dialogs, no saved files — just a silent ✓ badge when done

## Installation

> The extension is not yet on the Chrome Web Store. Install it manually in a few steps.

1. Download this repository: click **Code → Download ZIP** and unzip it
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the unzipped folder
5. The camera icon appears in your toolbar — you're ready to go

## Usage

| Action | Trigger |
|---|---|
| Capture full page → clipboard | `Ctrl+Shift+S` (Windows/Linux) |
| Capture full page → clipboard | `Cmd+Shift+S` (Mac) |
| Capture full page → clipboard | Click the toolbar icon |

A green **✓** badge on the icon confirms the screenshot is in your clipboard. Paste it with `Ctrl+V` / `Cmd+V`.

### Change the shortcut

Go to `chrome://extensions/shortcuts` to reassign the keyboard shortcut.

## How it works

The extension uses the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (the same API that powers DevTools' own "Capture full size screenshot") to measure the full page dimensions and take the screenshot. The resulting PNG is then written to the clipboard by injecting a small script into the current tab.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Access to Chrome DevTools Protocol for full-page capture |
| `activeTab` | Read the current tab |
| `tabs` | Query the active tab |
| `scripting` | Inject the clipboard write into the current tab |
| `clipboardWrite` | Write the image to the clipboard |

## License

MIT
