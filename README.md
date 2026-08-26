# GIF Recorder

A minimal Chrome Manifest V3 extension that records the visible area of the current tab as an animated GIF and automatically saves it to Chrome's Downloads folder when you stop.

## Install on macOS

1. Unzip the extension folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Choose the `tab-gif-recorder` folder.
6. Pin **GIF Recorder** from the Extensions menu if you want quick access.

## Use

1. Open the web page you want to record.
2. Click the extension icon.
3. Click **Start recording**.
4. Browse/interact with that same tab. The popup can be closed while recording.
5. Click the extension icon again and click **Stop recording**.
6. The GIF downloads automatically to your normal Chrome Downloads folder.

## Notes

- Records the visible tab area only (not browser chrome, address bar, or other apps).
- Default capture is 8 FPS and scales large tabs down to fit within 960×720 to keep GIF sizes manageable.
- GIF is a 256-color format, so gradients/video will look more compressed than a screen recording.
- Long recordings can make very large GIF files. Keep clips short when possible.
- Chrome internal pages such as `chrome://extensions` cannot be recorded.
- The download location follows Chrome's configured Downloads folder. If Chrome is set to ask where to save each file, Chrome may still prompt according to that browser setting.
