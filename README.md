# PhantomCam

**A virtual camera and AI note-taker for Google Meet.**

PhantomCam hooks `getUserMedia` on `meet.google.com` and routes your webcam through a
canvas pipeline, so you can freeze your feed, replay a short "I'm still here" clip, or
go straight back to live — without touching Meet's own UI. It also reads Meet's live
captions into a transcript and can turn that transcript into meeting notes with Gemini.

Manifest V3 · No build step · No analytics · MIT licensed

---

## What it does

| Feature | Description |
| --- | --- |
| **Live** | Normal webcam passthrough. Default state. |
| **Freeze** | Snapshot the current frame and hold it. The canvas keeps repainting at 30 fps, so Meet never sees a stalled track. |
| **15s loop** | Plays back the last ~15 seconds of frames on repeat. A background sampler keeps a rolling buffer, so the loop starts instantly instead of waiting for a fresh recording. |
| **Record clip** | Explicitly record a new 15-second loop, with a progress indicator. |
| **Transcript** | Captures turns from Google Meet's live captions (CC) into a scrollable log inside an in-meeting HUD. |
| **Summary** | Sends the transcript to Gemini and renders executive summary, decisions, and action items. |

The in-meeting HUD appears in the bottom-right of the call. It can be dragged, minimized,
and collapsed per section, and every action is bound to a keyboard or mouse shortcut.

---

## Responsible use

This tool deliberately makes your camera output differ from reality. That is its whole
point, and it is also what you should be careful about.

- Freezing or looping your camera signals to other participants that you are present when
  you may not be. Tell the people you meet with, or don't use it in that meeting.
- Many employers, schools, and platforms prohibit camera substitution in assessments,
  proctored exams, interviews, and recorded meetings. Using PhantomCam there can violate
  policy or an agreement you have signed, and in some jurisdictions the law.
- Google Meet's Terms of Service are between you and Google. This project is not
  affiliated with, endorsed by, or supported by Google.

Broadcast software such as OBS has offered virtual-camera features for years and they are
legitimate tools. Use this one the same way: for privacy, for a flaky connection, for a
moment away from the desk — not to misrepresent yourself to someone who is relying on
what they see.

---

## Install (from source)

PhantomCam is not on the Chrome Web Store. Load it unpacked:

1. Download or clone this repository.
   ```bash
   git clone https://github.com/juetco2/phantomcam.git
   ```
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc…).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder — the one containing
   `manifest.json`.
5. Pin PhantomCam to the toolbar.

Requires Chrome 111 or newer (the manifest uses `world: "MAIN"` content scripts).

---

## Usage

### Camera modes

Open the popup from the toolbar, or use the in-meeting HUD.

- **Live** — click **● Live**, or press your live shortcut.
- **Freeze** — click **❄ Freeze** the moment you step away.
- **15s Loop** — click **🔄 Loop 15s**. It replays the rolling buffer immediately. Click it
  again (it becomes **Exit Loop**) to return to live.
- **Record Fresh 15s Clip** — force a new recording when you want a specific clip, for
  example after you have just sat down and settled.

The first time a meeting calls `getUserMedia`, Chrome will show the normal camera
permission prompt. PhantomCam needs the real camera either way — it renders your actual
feed, just with the ability to substitute frames.

### Shortcuts

| Action | Default |
| --- | --- |
| Freeze | `F` |
| Resume live | `L` |

Rebind both in **Settings**. Mouse side buttons are supported: the **Mouse 3 / 4 preset**
maps back/forward buttons to Freeze and Live. PhantomCam swallows those buttons inside the
Meet tab and the popup so they never navigate the browser away from your call.

Shortcuts are ignored while you are typing in chat, notes, or any text field.

### Transcripts and summaries

1. Turn on **Captions (CC)** in Google Meet.
2. Speak, or let others speak. Turns appear in the HUD, and are saved to extension storage
   as they arrive.
3. Click **✨ Summarize Discussion with Gemini** in the HUD, or open the popup's
   **Summary** tab.

The transcript is plain text and stays in your browser until you send it for summarization.

---

## Configuration

### Gemini API key

Summarization needs a key. Get one from [Google AI Studio](https://aistudio.google.com/apikey),
then paste it into the popup under **Settings → Custom Gemini API key**.

- Stored with `chrome.storage.local`: local to this browser profile, not synced to your
  Google account, not readable by websites.
- Used only to call the Gemini API, and only from the extension's service worker.
- Without a key, transcripts still work; only the summarize button is affected.

### Models

The service worker tries `gemini-2.5-flash` and falls back to `gemini-2.0-flash` if the
first is unavailable for your key. To use a different model, edit `GEMINI_MODELS` at the
top of `background.js` — and update the label in `popup.html` if you want the Settings tab
to match.

### Keybind storage

`phantomcamFreezeKey` and `phantomcamLiveKey` in `chrome.storage.local`. Clearing extension
data restores the `F` / `L` defaults.

---

## How it works

```
meet.google.com
├── injector.js        MAIN world, document_start
│   └── overrides navigator.mediaDevices.getUserMedia
│       ├── real camera  ->  hidden <video>
│       ├── hidden <video> -> canvas (every animation frame, 30 fps)
│       ├── canvas.captureStream(30) -> returned to Meet
│       └── audio tracks copied through untouched
│
├── content.js         isolated world, document_idle
│   ├── in-meeting HUD (Shadow-free DOM, prefixed classes)
│   ├── MutationObserver on Meet captions -> transcriptLog
│   └── chrome.runtime messaging with popup + worker
│
└── popup.html/js      toolbar UI, preview canvas, transcripts, settings

background.js         service worker
└── the only code that calls the Gemini API
```

A few details worth knowing if you are modifying it:

- **Freeze does not stop the track.** A paused `MediaStreamTrack` looks like a stalled
  camera to Meet, which can drop your video entirely. PhantomCam keeps painting the frozen
  frame at 30 fps instead.
- **Frames are `ImageBitmap`s where available.** 15 seconds at 8 fps is ~120 frames; using
  canvases per frame exhausts the browser's 2D context limit. There is a single-canvas
  `ImageData` fallback for browsers without `createImageBitmap`.
- **The canvas resolution is fixed at attach time.** Resizing later changes the resolution
  of the track Meet is already consuming.
- **Summaries go through the service worker.** Content scripts inherit the page's origin
  and CORS rules; the worker has `host_permissions`, so the API call doesn't depend on
  Gemini sending CORS headers.

---

## Project layout

```
phantomcam/
├── manifest.json      MV3 manifest
├── background.js      service worker + Gemini client
├── injector.js        getUserMedia hook (MAIN world)
├── content.js         HUD, caption capture, messaging
├── content.css        HUD styles (all classes prefixed mcp-)
├── popup.html         toolbar panel markup + styles
├── popup.js           toolbar panel logic
├── icon16.png         toolbar icons
├── icon48.png
├── icon128.png
├── icon256.png        README / store artwork
├── PRIVACY.md
├── CHANGELOG.md
└── LICENSE
```

---

## Limitations and known issues

- **Meet only.** `manifest.json` limits everything to `meet.google.com`. Other providers use
  different player and caption DOM.
- **Caption scraping is best-effort.** Google Meet's caption classes are obfuscated and
  change between builds; `scanMeetCaptions()` matches a few known shapes and will need
  updating when Meet ships a redesign. Auto-generated captions lag a second or two.
- **Loop length is approximate.** The buffer holds 120 frames at 8 fps, so roughly 15
  seconds. If your machine drops frames, the clip is shorter.
- **One tab at a time.** The popup controls the first Meet tab it finds.
- **Firefox is not supported.** MV3 `world: "MAIN"` content scripts and
  `canvas.captureStream` behave differently there.
- **No offline summarization.** The AI features require network access to Google's API.

---

## Privacy

Short version: nothing leaves your browser except the transcript text you choose to
summarize, sent directly to Google's Gemini API with your own key. No analytics, no
telemetry, no third-party servers. See [PRIVACY.md](PRIVACY.md).

---

## Contributing

Issues and pull requests are welcome. There is no build step and no dependencies:

1. Edit the files.
2. Reload the extension at `chrome://extensions` (the refresh icon on the PhantomCam card).
3. Reload the Meet tab.

Please keep the `mcp-` class prefix on injected DOM, and check `node --check <file>` before
committing. If Meet changes its caption markup, a PR that updates the selectors in
`content.js` is genuinely useful.

---

## License

[MIT](LICENSE) © 2026 juetco2

Google Meet and Gemini are trademarks of Google LLC. This project is independent and not
affiliated with Google.
