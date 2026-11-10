# Changelog

All notable changes to PhantomCam are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-10

First public release. The camera engine is unchanged in behaviour from the 1.0.0 build;
this release fixes correctness, security and packaging problems that blocked publishing.

### Fixed

- **Resume-live shortcuts threw an error.** Both the keyboard and mouse handlers called a
  `handleLiveAction()` function that did not exist; they now call `resumeLiveFeed()`.
- **Gemini model name was invalid.** `gemini-3.8-flash` does not exist. The service worker
  now targets `gemini-2.5-flash` with a `gemini-2.0-flash` fallback.
- **Summaries could fail on CORS.** Content-script `fetch` calls inherit the page's origin.
  All Gemini traffic now goes through the service worker, which has `host_permissions`.
- **Markdown rendering could inject HTML.** Model output is escaped before the small
  Markdown subset is applied.
- **Duplicate injector execution.** `injector.js` was declared as a MAIN-world content
  script *and* injected again via a `<script>` tag. The tag and its `web_accessible_resources`
  entry were removed.
- **Leaked canvas streams.** Re-acquiring the camera (device switch, camera toggle) now
  stops the previous canvas video track. Audio tracks are left untouched so the live call
  keeps its microphone.
- **Video resolution changed mid-call.** The render loop no longer resizes the canvas after
  the stream has been handed to Meet.
- **Transcript data never reached the popup.** The popup read `storedTranscripts`, but
  nothing ever wrote it. Caption turns are now persisted (debounced) and cleared across both
  the popup and the Meet tab.
- **Icons were the same 1024×1024 file.** Proper 16/48/128/256 px assets are now generated.

### Changed

- Name is now *PhantomCam — Virtual Camera & Meeting Notes*; the "stealth" framing was
  dropped in favour of describing what the tool does.
- Caption scanning is debounced instead of running a full `querySelectorAll` on every DOM
  mutation.
- Settings copy, specs panel and README no longer reference the removed Companion
  Simulator endpoint.
- Manifest permissions reduced to `storage` + `tabs`; unused `activeTab` and `scripting`
  removed. Added `generativelanguage.googleapis.com` to `host_permissions`.
- Invalid CSS property `shrink: 0` corrected to `flex-shrink: 0`.
- Unused `popupLoopVideo` element removed.

### Added

- `README.md`, `PRIVACY.md`, `LICENSE`, `CHANGELOG.md`, `.gitignore`.
- Friendly errors for a missing API key, empty transcript, and API failures.
- API key sent as an `x-goog-api-key` header instead of a URL query parameter.

## [1.0.0]

- Initial build: `getUserMedia` hook, freeze frame, 15-second rolling loop, in-meeting HUD,
  caption transcript, Gemini summarization, rebindable keyboard and mouse shortcuts.
