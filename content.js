/**
 * PhantomCam content script: in-meeting HUD, caption capture and summarization.
 * Injected on meet.google.com
 */
(() => {
  console.log('[PhantomCam] Content script activated.');

  // injector.js is declared in the manifest as a MAIN-world content script, so
  // it is already running before this file loads. Injecting it again here would
  // run the getUserMedia hook twice, so no dynamic injection happens.

  // 1. Transcript & Camera State
  let transcriptLog = [];
  let cameraState = {
    mode: 'live',
    progressSec: 0,
    totalSec: 15
  };
  let customApiKey = '';
  let freezeKey = 'F';
  let liveKey = 'L';
  let toastTimer = null;

  // Load custom API key and keybind shortcuts from chrome storage
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['geminiApiKey', 'phantomcamFreezeKey', 'phantomcamLiveKey'], (res) => {
      if (res) {
        if (res.geminiApiKey) customApiKey = res.geminiApiKey;
        if (res.phantomcamFreezeKey) freezeKey = res.phantomcamFreezeKey.toUpperCase();
        if (res.phantomcamLiveKey) liveKey = res.phantomcamLiveKey.toUpperCase();
        updateHudKeyBadges();
      }
    });

    // Real-time sync if user modifies keybinds in extension popup
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
          if (changes.geminiApiKey) customApiKey = changes.geminiApiKey.newValue || '';
          if (changes.phantomcamFreezeKey) freezeKey = (changes.phantomcamFreezeKey.newValue || 'F').toUpperCase();
          if (changes.phantomcamLiveKey) liveKey = (changes.phantomcamLiveKey.newValue || 'L').toUpperCase();
          updateHudKeyBadges();
        }
      });
    }
  }

  // Persisted transcript cache, so opening the popup later still shows the
  // turns that were captured during a call. Debounced to avoid writing on
  // every caption mutation.
  let transcriptSaveTimer = null;

  function saveTranscripts() {
    if (!chrome.storage || !chrome.storage.local) return;
    if (transcriptSaveTimer) clearTimeout(transcriptSaveTimer);
    transcriptSaveTimer = setTimeout(() => {
      transcriptSaveTimer = null;
      chrome.storage.local.set({
        storedTranscripts: transcriptLog.map(({ speaker, text, time }) => ({ speaker, text, time }))
      });
    }, 800);
  }

  // Floating In-Meeting Keybind Toast Notification
  function showKeyToast(text, type = 'freeze') {
    let toast = document.getElementById('mcp-key-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mcp-key-toast';
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.className = `show toast-${type}`;
    toast.textContent = text;

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2400);
  }

  function isMouseTarget(setting, buttonIndex) {
    if (!setting) return false;
    const s = setting.toLowerCase().replace(/[\s_\-]/g, '');
    if (buttonIndex === 3) return s === 'mouse3' || s === 'button3';
    if (buttonIndex === 4) return s === 'mouse4' || s === 'button4';
    if (buttonIndex === 1) return s === 'mousemiddle' || s === 'middle';
    return false;
  }

  // Intercept and override Mouse Button 3 (Back) and Mouse Button 4 (Forward) inside Google Meet
  window.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) {
      // Completely prevent browser navigation away from meeting
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const isFreeze = isMouseTarget(freezeKey, e.button) || (e.button === 3 && freezeKey.toLowerCase().includes('mouse 3'));
      const isLive = isMouseTarget(liveKey, e.button) || (e.button === 4 && liveKey.toLowerCase().includes('mouse 4'));

      if (isFreeze) {
        sendCommandToInjector('FREEZE');
        showKeyToast(`❄ Camera Frozen [Mouse ${e.button} (Side Button)]`, 'freeze');
      } else if (isLive) {
        sendCommandToInjector('RESUME_LIVE');
        showKeyToast(`● Camera Resumed Live [Mouse ${e.button} (Side Button)]`, 'live');
      }
    }
  }, true);

  window.addEventListener('auxclick', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  // Keyboard shortcut listener on Meet tab
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    // Guard against typing in chat input, notes, or text fields
    if (
      target && (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable ||
        (target.getAttribute && target.getAttribute('role') === 'textbox') ||
        target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')
      )
    ) {
      return;
    }

    const pressed = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const currentFreeze = (freezeKey || 'F').trim();
    const currentLive = (liveKey || 'L').trim();

    if (!currentFreeze.toLowerCase().includes('mouse') && pressed === currentFreeze.toUpperCase()) {
      e.preventDefault();
      sendCommandToInjector('FREEZE');
      showKeyToast(`❄ Camera Frozen [Key ${currentFreeze}]`, 'freeze');
    } else if (!currentLive.toLowerCase().includes('mouse') && pressed === currentLive.toUpperCase()) {
      e.preventDefault();
      sendCommandToInjector('RESUME_LIVE');
      showKeyToast(`● Camera Resumed Live [Key ${currentLive}]`, 'live');
    }
  });

  // 3. Listen to messages from injector.js
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'meet-copilot-injector') return;

    if (event.data.type === 'STATUS_UPDATE') {
      cameraState = event.data.data;
      updateHudCameraUI();
    }
  });

  // 3.1 Listen to messages from extension popup.js
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'GET_MEET_STATE') {
        sendResponse({
          isMeetTab: true,
          cameraState,
          transcriptLog,
          meetingUrl: window.location.href
        });
        return true;
      }
      if (request.action === 'TRIGGER_CAM_CMD') {
        sendCommandToInjector(request.command);
        sendResponse({ success: true, command: request.command });
        return true;
      }
      if (request.action === 'GET_TRANSCRIPTS') {
        sendResponse({ transcriptLog });
        return true;
      }
      if (request.action === 'CLEAR_TRANSCRIPTS') {
        transcriptLog = [];
        renderTranscripts();
        saveTranscripts();
        sendResponse({ success: true });
        return true;
      }
    });
  }

  // 4. Inject Floating In-Meeting HUD
  function createHud() {
    if (document.getElementById('meet-copilot-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'meet-copilot-hud';
    hud.innerHTML = `
      <div class="mcp-header" id="mcp-drag-handle">
        <div class="mcp-title">
          <div class="mcp-logo-badge">
            <img src="${chrome.runtime.getURL('icon48.png')}" class="mcp-logo-img" alt="PhantomCam" />
          </div>
          <span style="font-weight: 800; letter-spacing: -0.01em;">PhantomCam</span>
          <span class="mcp-badge" id="mcp-status-badge">Live</span>
        </div>
        <div class="mcp-controls">
          <button class="mcp-btn-icon" id="mcp-minimize-btn" title="Minimize / Expand Window" aria-label="Minimize or Expand">
            <svg class="mcp-icon-svg mcp-icon-min" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <svg class="mcp-icon-svg mcp-icon-exp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          </button>
        </div>
      </div>
      <div class="mcp-body" id="mcp-body-content">
        <!-- Camera Controls -->
        <div class="mcp-cam-section">
          <div class="mcp-section-title">
            <span>Camera Camouflage</span>
            <span id="mcp-cam-label" style="color: #38bdf8;">Webcam Live</span>
          </div>
          <div class="mcp-btn-grid">
            <button class="mcp-cam-btn active" id="mcp-btn-live" title="Resume live camera">
              <span>● Live</span>
              <span class="mcp-key-badge" id="mcp-badge-live">L</span>
            </button>
            <button class="mcp-cam-btn btn-freeze" id="mcp-btn-freeze" title="Freeze camera feed">
              <span>❄ Freeze</span>
              <span class="mcp-key-badge" id="mcp-badge-freeze">F</span>
            </button>
            <button class="mcp-cam-btn btn-loop" id="mcp-btn-loop" title="15-second virtual loop">
              <span>🔄 Loop 15s</span>
            </button>
          </div>
          <button class="mcp-cam-btn" id="mcp-btn-record" style="margin-top: 4px; padding: 6px 10px; font-size: 10px; border-style: dashed; color: #94a3b8; width: 100%;">
            <span>🔴 Record Fresh 15s Clip</span>
          </button>
          <div class="mcp-progress-bar" id="mcp-prog-bar">
            <div class="mcp-progress-fill" id="mcp-prog-fill"></div>
          </div>
        </div>

        <!-- Live Transcripts Section with Minimize Button -->
        <div class="mcp-cam-section" id="mcp-transcripts-section">
          <div class="mcp-section-title">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span>Real-time Transcription</span>
              <span id="mcp-count-label" style="font-size: 10px; color: #64748b;">0 turns</span>
            </div>
            <button class="mcp-sub-toggle-btn" id="mcp-toggle-transcripts-btn" title="Minimize / Expand Transcripts" aria-label="Minimize or Expand Transcripts">
              <span class="mcp-sub-toggle-label">Minimize</span>
              <svg class="mcp-chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
          </div>
          <div class="mcp-transcripts-collapsible" id="mcp-transcripts-collapsible">
            <div class="mcp-transcripts-box" id="mcp-transcripts-box">
              <div style="color: #64748b; font-style: italic; text-align: center; padding: 14px 0;">
                Turn on Meet Captions (CC) or speak to begin logging...
              </div>
            </div>
          </div>
        </div>

        <!-- Summarize Action -->
        <button class="mcp-summarize-btn" id="mcp-summarize-btn">
          <span>✨ Summarize Discussion with Gemini</span>
        </button>

        <!-- Summary Modal Result -->
        <div class="mcp-summary-result" id="mcp-summary-result" style="display: none;">
          <div style="font-weight: 700; color: #818cf8; margin-bottom: 6px;">Meeting Minutes & Action Items</div>
          <div id="mcp-summary-text"></div>
        </div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(hud);

    // Wire Dragging
    const dragHandle = document.getElementById('mcp-drag-handle');
    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = hud.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      hud.style.bottom = 'auto';
      hud.style.right = 'auto';
      hud.style.left = `${startLeft}px`;
      hud.style.top = `${startTop}px`;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      hud.style.left = `${startLeft + dx}px`;
      hud.style.top = `${startTop + dy}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Spotlight pointer glow tracking across HUD
    hud.addEventListener('mousemove', (e) => {
      const rect = hud.getBoundingClientRect();
      hud.style.setProperty('--spot-x', `${e.clientX - rect.left}px`);
      hud.style.setProperty('--spot-y', `${e.clientY - rect.top}px`);
    });

    // Wire HUD Controls
    const btnLive = document.getElementById('mcp-btn-live');
    const btnFreeze = document.getElementById('mcp-btn-freeze');
    const btnLoop = document.getElementById('mcp-btn-loop');
    const btnRecord = document.getElementById('mcp-btn-record');
    const btnSummarize = document.getElementById('mcp-summarize-btn');
    const btnMinimize = document.getElementById('mcp-minimize-btn');
    const btnToggleTranscripts = document.getElementById('mcp-toggle-transcripts-btn');
    const transcriptsCollapsible = document.getElementById('mcp-transcripts-collapsible');
    let isTranscriptsMinimized = false;

    btnLive.onclick = () => sendCommandToInjector('RESUME_LIVE');
    btnFreeze.onclick = () => sendCommandToInjector('FREEZE');
    btnLoop.onclick = () => {
      if (cameraState.mode === 'looping' || cameraState.mode === 'recording') {
        sendCommandToInjector('RESUME_LIVE');
      } else {
        sendCommandToInjector('INSTANT_LOOP');
      }
    };
    if (btnRecord) {
      btnRecord.onclick = () => sendCommandToInjector('RECORD_LOOP');
    }
    btnSummarize.onclick = handleSummarizeRequest;

    // Smooth HUD minimize / expand
    btnMinimize.onclick = (e) => {
      e.stopPropagation();
      hud.classList.toggle('minimized');
    };

    // Dedicated Transcripts box minimize / expand
    if (btnToggleTranscripts && transcriptsCollapsible) {
      btnToggleTranscripts.onclick = (e) => {
        e.stopPropagation();
        isTranscriptsMinimized = !isTranscriptsMinimized;
        transcriptsCollapsible.classList.toggle('collapsed', isTranscriptsMinimized);
        btnToggleTranscripts.classList.toggle('collapsed', isTranscriptsMinimized);
        const label = btnToggleTranscripts.querySelector('.mcp-sub-toggle-label');
        if (label) label.textContent = isTranscriptsMinimized ? 'Expand' : 'Minimize';
      };
    }

    // Initial status request & key badge update
    updateHudKeyBadges();
    sendCommandToInjector('GET_STATUS');
  }

  function updateHudKeyBadges() {
    const bFreeze = document.getElementById('mcp-badge-freeze');
    const bLive = document.getElementById('mcp-badge-live');
    if (bFreeze) bFreeze.textContent = (freezeKey || 'F').toUpperCase();
    if (bLive) bLive.textContent = (liveKey || 'L').toUpperCase();
  }

  function sendCommandToInjector(command) {
    window.postMessage({
      source: 'meet-copilot-content',
      command
    }, '*');
  }

  function updateHudCameraUI() {
    const badge = document.getElementById('mcp-status-badge');
    const camLabel = document.getElementById('mcp-cam-label');
    const btnLive = document.getElementById('mcp-btn-live');
    const btnFreeze = document.getElementById('mcp-btn-freeze');
    const btnLoop = document.getElementById('mcp-btn-loop');
    const progBar = document.getElementById('mcp-prog-bar');
    const progFill = document.getElementById('mcp-prog-fill');

    if (!badge || !camLabel || !btnLive || !btnFreeze || !btnLoop || !progBar || !progFill) return;

    btnLive.classList.remove('active');
    btnFreeze.classList.remove('active');
    btnLoop.classList.remove('active');

    if (cameraState.mode === 'recording') {
      badge.textContent = `REC ${cameraState.progressSec}/${cameraState.totalSec}s`;
      badge.style.color = '#f87171';
      badge.style.background = 'rgba(239, 68, 68, 0.2)';
      camLabel.textContent = `Capturing Loop (${cameraState.progressSec}s)`;
      btnLoop.classList.add('active');
      progBar.style.display = 'block';
      const pct = Math.min(100, Math.round((cameraState.progressSec / cameraState.totalSec) * 100));
      progFill.style.width = `${pct}%`;
    } else if (cameraState.mode === 'looping') {
      badge.textContent = 'Looping (15s)';
      badge.style.color = '#c084fc';
      badge.style.background = 'rgba(168, 85, 247, 0.2)';
      camLabel.textContent = '15s Clip Playing';
      btnLoop.classList.add('active');
      progBar.style.display = 'none';
    } else if (cameraState.mode === 'frozen') {
      badge.textContent = 'Frozen';
      badge.style.color = '#2dd4bf';
      badge.style.background = 'rgba(45, 212, 191, 0.2)';
      camLabel.textContent = 'Camera Paused';
      btnFreeze.classList.add('active');
      progBar.style.display = 'none';
    } else {
      badge.textContent = 'Live';
      badge.style.color = '#7dd3fc';
      badge.style.background = 'rgba(56, 189, 248, 0.15)';
      camLabel.textContent = 'Webcam Live';
      btnLive.classList.add('active');
      progBar.style.display = 'none';
    }
  }

  // 5. Native Google Meet Closed Caption Observer
  // Meet's caption class names are obfuscated and change between builds, so this
  // matches several known shapes. Scans are debounced because the observer fires
  // on every DOM mutation and a full querySelectorAll is expensive.
  let captionObserver = null;
  let captionScanScheduled = false;

  function scanMeetCaptions() {
    const captionNodes = document.querySelectorAll('.iTTPOb, [jsname="YSvyfd"], [jscontroller="D1tHje"]');
    let dirty = false;

    captionNodes.forEach((node) => {
      const speakerEl = node.querySelector('.zs7Du, [data-sender-name]') || node.previousElementSibling;
      const textEl = node.querySelector('.iTTPOb') || node;

      const speaker = speakerEl ? speakerEl.textContent.trim() : 'Speaker';
      const text = textEl.textContent.trim();

      if (!text || text.length <= 2) return;

      const lastEntry = transcriptLog[transcriptLog.length - 1];
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Same speaker within 6 seconds: keep growing the existing turn.
      if (lastEntry && lastEntry.speaker === speaker && (Date.now() - lastEntry.rawTime < 6000)) {
        if (lastEntry.text !== text && !lastEntry.text.includes(text)) {
          lastEntry.text += ' ' + text;
          lastEntry.rawTime = Date.now();
          dirty = true;
        }
      } else {
        transcriptLog.push({ speaker, text, time, rawTime: Date.now() });
        dirty = true;
      }
    });

    if (dirty) {
      renderTranscripts();
      saveTranscripts();
    }
  }

  function observeMeetCaptions() {
    if (captionObserver) return;

    captionObserver = new MutationObserver(() => {
      if (captionScanScheduled) return;
      captionScanScheduled = true;
      setTimeout(() => {
        captionScanScheduled = false;
        scanMeetCaptions();
      }, 250);
    });

    captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function renderTranscripts() {
    const box = document.getElementById('mcp-transcripts-box');
    const countLabel = document.getElementById('mcp-count-label');
    if (!box) return;

    if (countLabel) countLabel.textContent = `${transcriptLog.length} turns`;

    if (transcriptLog.length === 0) {
      box.innerHTML = `
        <div style="color: #64748b; font-style: italic; text-align: center; padding: 12px 0;">
          Turn on Meet Captions (CC) or speak to begin logging...
        </div>
      `;
      return;
    }

    box.innerHTML = transcriptLog.map((item) => `
      <div class="mcp-transcript-row">
        <span class="mcp-transcript-speaker">${escapeHtml(item.speaker)}:</span>
        <span>${escapeHtml(item.text)}</span>
        <span class="mcp-transcript-time">${item.time}</span>
      </div>
    `).join('');

    box.scrollTop = box.scrollHeight;
  }

  // 6. Summarize with Gemini (delegated to the service worker, which holds the key)
  async function handleSummarizeRequest() {
    const btn = document.getElementById('mcp-summarize-btn');
    const resultBox = document.getElementById('mcp-summary-result');
    const resultText = document.getElementById('mcp-summary-text');

    if (!transcriptLog || transcriptLog.length === 0) {
      showKeyToast('Turn on Meet captions (CC) and let people speak first.', 'freeze');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Gemini is generating meeting summary...</span>';
    resultBox.style.display = 'block';
    resultText.innerHTML = '<span style="color: #94a3b8;">Analyzing the conversation and action items...</span>';

    const transcript = transcriptLog.map(t => `[${t.time}] ${t.speaker}: ${t.text}`).join('\n');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'GEMINI_SUMMARIZE',
        transcript,
        apiKey: customApiKey || undefined
      });

      if (!response || !response.ok) {
        resultText.innerHTML = response?.error === 'MISSING_API_KEY'
          ? `<span style="color: #fbbf24;">Add a Gemini API key in the PhantomCam popup
               (<strong>Settings &rarr; Custom Gemini API key</strong>) to generate summaries.</span>`
          : `<span style="color: #f87171;">Summary failed: ${escapeHtml(response?.error || 'unknown error')}</span>`;
      } else {
        resultText.innerHTML = formatMarkdown(response.text);
      }
    } catch (err) {
      console.error('[PhantomCam] Summary error:', err);
      resultText.innerHTML = `<span style="color: #f87171;">Summary failed: ${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>✨ Summarize Discussion with Gemini</span>';
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  // Escape first, then apply the small Markdown subset we ask Gemini for, so
  // model output can never inject markup into the page.
  function formatMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^[-*]\s+/gm, '• ')
      .replace(/\n/g, '<br/>');
  }

  // Initialize once page is ready
  window.addEventListener('load', () => {
    setTimeout(() => {
      createHud();
      observeMeetCaptions();
    }, 2000);
  });

  // Also check immediately in case page already loaded
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => {
      createHud();
      observeMeetCaptions();
    }, 1500);
  }

  // Periodic safeguard for Google Meet SPA navigation between lobby and active call
  setInterval(() => {
    if (window.location.hostname.includes('meet.google.com')) {
      if (!document.getElementById('meet-copilot-hud')) {
        createHud();
      }
    }
  }, 2500);
})();
