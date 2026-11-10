# Privacy

PhantomCam has no backend. There is no server, no account, no analytics, and no telemetry
of any kind. This document describes every piece of data the extension touches.

## What stays on your device

| Data | Where it lives | Why |
| --- | --- | --- |
| Gemini API key | `chrome.storage.local` | Authenticates your summarization requests |
| Captured transcript | `chrome.storage.local`, key `storedTranscripts` | So the popup can show turns from the current call |
| Freeze / live shortcuts | `chrome.storage.local` | Restores your keybind choice |

`chrome.storage.local` is scoped to your browser profile. It is not synced to your Google
account (that would be `chrome.storage.sync`, which PhantomCam does not use), and it is not
accessible to any website, including `meet.google.com`.

Camera frames, the rolling 15-second buffer, and frozen snapshots are held in memory only.
They are never written to disk and never leave your machine. Closing the tab discards them.

To erase everything: `chrome://extensions` → PhantomCam → **Remove**, or clear the
extension's site data.

## What leaves your device, and only when you ask

**Transcript text → Google Gemini API.** When you press *Summarize*, the transcript is sent
to `generativelanguage.googleapis.com` using your own API key. That is the only outbound
network request the extension makes. It is a direct request from your browser to Google,
subject to [Google's API terms](https://ai.google.dev/terms) and the
[Gemini API data policies](https://ai.google.dev/gemini-api/terms).

If you never press *Summarize*, no transcript data leaves your browser at all. Live
transcription is local: it reads the caption text Google Meet already renders on your screen.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save your API key, shortcuts, and transcript cache |
| `tabs` | Find the open Meet tab and send camera commands to it |
| `host_permissions: meet.google.com` | Run the content scripts and HUD on Meet pages |
| `host_permissions: generativelanguage.googleapis.com` | Call the Gemini API from the service worker |

PhantomCam does not request `activeTab`, `scripting`, `cookies`, `history`, `webRequest`,
`<all_urls>`, or any other broad permission.

## Third parties

None. No CDN, no fonts, no remote scripts, no image hosting. Every asset ships in the
extension package, which is why it works offline (except summarization).

Google Meet and Gemini are services provided by Google LLC. Your use of them is governed by
your agreement with Google, not by this project.
