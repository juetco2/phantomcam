/**
 * PhantomCam popup controller.
 * Full-featured interactive Chrome Extension dashboard with guaranteed Frame Buffer Loop Engine.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const meetConnBadge = document.getElementById('meetConnBadge');
  const meetSyncBanner = document.getElementById('meetSyncBanner');
  const meetSyncText = document.getElementById('meetSyncText');
  const btnFocusMeet = document.getElementById('btnFocusMeet');

  // Camera elements
  const popupCanvas = document.getElementById('popupCanvas');
  const popupVideo = document.getElementById('popupVideo');
  const stageBadge = document.getElementById('stageBadge');
  const recBar = document.getElementById('recBar');
  const recFill = document.getElementById('recFill');
  const btnLive = document.getElementById('btnLive');
  const btnFreeze = document.getElementById('btnFreeze');
  const btnLoop = document.getElementById('btnLoop');
  const loopBtnLabel = document.getElementById('loopBtnLabel');
  const telemetryState = document.getElementById('telemetryState');
  const modeDescription = document.getElementById('modeDescription');
  const btnRequestHardwareCam = document.getElementById('btnRequestHardwareCam');
  const camSourceLabel = document.getElementById('camSourceLabel');
  const actionToast = document.getElementById('actionToast');

  // Transcripts elements
  const transcriptsContainer = document.getElementById('transcriptsContainer');
  const transcriptSearch = document.getElementById('transcriptSearch');
  const turnsCount = document.getElementById('turnsCount');
  const btnSimulate = document.getElementById('btnSimulate');
  const btnClearTranscripts = document.getElementById('btnClearTranscripts');

  // Summary elements
  const btnGenerateSummary = document.getElementById('btnGenerateSummary');
  const summaryOutput = document.getElementById('summaryOutput');
  const btnCopySummary = document.getElementById('btnCopySummary');

  // Settings elements
  const customApiKeyInput = document.getElementById('customApiKeyInput');
  const btnSaveKey = document.getElementById('btnSaveKey');
  const saveConfirmMsg = document.getElementById('saveConfirmMsg');

  // Keybind elements & indicators
  const popBadgeLive = document.getElementById('popBadgeLive');
  const popBadgeFreeze = document.getElementById('popBadgeFreeze');
  const btnRebindFreeze = document.getElementById('btnRebindFreeze');
  const btnRebindLive = document.getElementById('btnRebindLive');
  const btnResetKeybinds = document.getElementById('btnResetKeybinds');
  const btnPresetMouse = document.getElementById('btnPresetMouse');
  const mouseOverrideNotice = document.getElementById('mouseOverrideNotice');
  const keyCollisionWarning = document.getElementById('keyCollisionWarning');
  const keySaveConfirmMsg = document.getElementById('keySaveConfirmMsg');

  let freezeKey = 'F';
  let liveKey = 'L';
  let recordingKeyFor = null; // 'freeze' | 'live' | null

  // Footer links
  const linkOpenMeet = document.getElementById('linkOpenMeet');

  // Canvas context
  const ctx = popupCanvas.getContext('2d', { alpha: false });
  let currentCamMode = 'live'; // 'live' | 'recording' | 'looping' | 'frozen'
  let isUsingRealWebcam = false;
  let realWebcamStream = null;
  let animFrameId = null;

  // Single sampler canvas for context-safe ImageData capture
  let samplerCanvas = null;
  let samplerCtx = null;

  // Freeze Snapshot
  let frozenSnapshot = null;

  // Frame Buffer Loop Engine
  // Stores ImageBitmap or single-canvas ImageData to prevent canvas 2D context exhaustion
  let loopFrames = [];
  let rollingBuffer = [];
  const MAX_ROLLING_FRAMES = 120; // ~15 seconds at 8 FPS
  const FRAME_INTERVAL_MS = 125;  // 8 FPS capture
  let rollingSamplerInterval = null;
  let loopStartTime = 0;
  let loopRecordInterval = null;
  const LOOP_DURATION_SEC = 15;

  const btnRecordNew = document.getElementById('btnRecordNew');

  let activeMeetTab = null;
  let transcripts = [];
  let customApiKey = '';

  // 1. Toast Notification Helper
  function showToast(msg) {
    if (!actionToast) return;
    actionToast.textContent = msg;
    actionToast.style.display = 'block';
    setTimeout(() => {
      actionToast.style.display = 'none';
    }, 2800);
  }

  // Pointer-tracking radial spotlight for extension popup cards
  document.addEventListener('mousemove', (e) => {
    const spotlightElements = document.querySelectorAll('.card, .cam-stage');
    spotlightElements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
      el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
    });
  });

  async function captureSnapshot(source, w = 640, h = 360) {
    if (!source) return null;

    if (window.createImageBitmap) {
      try {
        const bmp = await window.createImageBitmap(source, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'medium'
        });
        return { type: 'bitmap', data: bmp };
      } catch (e) {
        // Fall back
      }
    }

    try {
      if (!samplerCanvas) {
        samplerCanvas = document.createElement('canvas');
        samplerCanvas.width = w;
        samplerCanvas.height = h;
        samplerCtx = samplerCanvas.getContext('2d', { willReadFrequently: true });
      }
      samplerCtx.drawImage(source, 0, 0, w, h);
      const imgData = samplerCtx.getImageData(0, 0, w, h);
      return { type: 'imagedata', data: imgData };
    } catch (err) {
      return null;
    }
  }

  function drawSnapshot(targetCtx, snap, dw, dh) {
    if (!snap || !targetCtx) return;
    if (snap.type === 'bitmap' && snap.data) {
      targetCtx.drawImage(snap.data, 0, 0, dw, dh);
    } else if (snap.type === 'imagedata' && snap.data) {
      if (!samplerCanvas) return;
      samplerCtx.putImageData(snap.data, 0, 0);
      targetCtx.drawImage(samplerCanvas, 0, 0, dw, dh);
    }
  }

  function freeSnapshot(snap) {
    if (snap && snap.type === 'bitmap' && snap.data && typeof snap.data.close === 'function') {
      snap.data.close();
    }
  }

  function clearFramesArray(arr) {
    while (arr.length > 0) {
      const snap = arr.pop();
      freeSnapshot(snap);
    }
  }

  // Background rolling buffer sampler
  function startRollingSampler() {
    if (rollingSamplerInterval) return;
    rollingSamplerInterval = setInterval(async () => {
      if (currentCamMode !== 'live') return;

      const source = (isUsingRealWebcam && popupVideo && popupVideo.readyState >= 2) ? popupVideo : popupCanvas;
      const snap = await captureSnapshot(source, popupCanvas.width, popupCanvas.height);
      if (!snap) return;

      rollingBuffer.push(snap);
      if (rollingBuffer.length > MAX_ROLLING_FRAMES) {
        const oldest = rollingBuffer.shift();
        freeSnapshot(oldest);
      }
    }, FRAME_INTERVAL_MS);
  }

  startRollingSampler();

  // 2. Continuous Canvas Render Loop (Guaranteed to NEVER be blank or drop frames)
  function renderCanvas() {
    if (!ctx) return;
    const w = popupCanvas.width;
    const h = popupCanvas.height;

    if (currentCamMode === 'frozen' && frozenSnapshot) {
      // 1. Draw frozen snapshot
      drawSnapshot(ctx, frozenSnapshot, w, h);
    } else if (currentCamMode === 'looping' && loopFrames.length > 0) {
      // 2. Draw active frame from 15-second loop buffer
      const elapsedMs = Date.now() - loopStartTime;
      const frameDurationMs = FRAME_INTERVAL_MS;
      const frameIdx = Math.floor(elapsedMs / frameDurationMs) % loopFrames.length;
      const curFrame = loopFrames[frameIdx];
      if (curFrame) {
        drawSnapshot(ctx, curFrame, w, h);
      }
    } else if (isUsingRealWebcam && popupVideo && popupVideo.readyState >= 2) {
      // 3. Draw live webcam feed
      ctx.drawImage(popupVideo, 0, 0, w, h);
    } else {
      // 4. Draw animated simulated camera avatar
      drawSimulatedFeed(ctx, w, h);
    }

    animFrameId = requestAnimationFrame(renderCanvas);
  }

  function drawSimulatedFeed(context, w, h) {
    const time = Date.now() * 0.002;

    // Background gradient
    const grad = context.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#0b1120');
    context.fillStyle = grad;
    context.fillRect(0, 0, w, h);

    // Warm studio ambient glow
    const lightX = w * 0.5 + Math.sin(time * 0.6) * 20;
    const rad = context.createRadialGradient(lightX, h * 0.4, 20, lightX, h * 0.4, 300);
    rad.addColorStop(0, 'rgba(56, 189, 248, 0.15)');
    rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = rad;
    context.fillRect(0, 0, w, h);

    // Person silhouette with gentle natural sway
    const headX = w * 0.5 + Math.cos(time * 0.8) * 3;
    const headY = h * 0.44 + Math.sin(time * 1.2) * 3;

    // Body shoulders
    context.fillStyle = '#334155';
    context.beginPath();
    context.ellipse(headX, h * 0.88, w * 0.24, h * 0.35, 0, 0, Math.PI * 2);
    context.fill();

    // Head
    context.fillStyle = '#64748b';
    context.beginPath();
    context.arc(headX, headY, h * 0.19, 0, Math.PI * 2);
    context.fill();

    // Eyewear / Face highlight
    context.fillStyle = '#94a3b8';
    context.beginPath();
    context.roundRect(headX - 40, headY - 14, 30, 16, 4);
    context.roundRect(headX + 10, headY - 14, 30, 16, 4);
    context.fill();

    // Status banner at bottom of stage
    context.fillStyle = 'rgba(0, 0, 0, 0.6)';
    context.fillRect(0, h - 34, w, 34);

    context.fillStyle = '#f8fafc';
    context.font = '600 13px system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(isUsingRealWebcam ? '● Real Camera Active' : '● Camera Standby (Click top-right to connect webcam)', 14, h - 12);

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    context.textAlign = 'right';
    context.fillStyle = '#94a3b8';
    context.fillText(nowStr, w - 14, h - 12);
  }

  // Start continuous rendering immediately
  renderCanvas();

  // 3. Hardware Webcam Connection
  async function connectHardwareWebcam() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Webcam API not supported in this context');
        return;
      }
      realWebcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 }
      });
      popupVideo.srcObject = realWebcamStream;
      await popupVideo.play().catch(() => {});
      isUsingRealWebcam = true;
      camSourceLabel.textContent = 'Webcam Connected';
      btnRequestHardwareCam.style.borderColor = '#4ade80';
      btnRequestHardwareCam.style.color = '#4ade80';
      showToast('Webcam feed connected!');
    } catch (err) {
      console.warn('Webcam permission error:', err);
      showToast('Camera access denied or device unavailable. Running in high-fidelity simulated mode.');
    }
  }

  btnRequestHardwareCam.addEventListener('click', () => {
    if (isUsingRealWebcam && realWebcamStream) {
      realWebcamStream.getTracks().forEach(t => t.stop());
      realWebcamStream = null;
      popupVideo.srcObject = null;
      isUsingRealWebcam = false;
      camSourceLabel.textContent = 'Use Real Webcam';
      btnRequestHardwareCam.style.borderColor = '#334155';
      btnRequestHardwareCam.style.color = '#94a3b8';
      showToast('Switched to simulated feed');
    } else {
      connectHardwareWebcam();
    }
  });

  // Try connecting webcam on mount, gracefully fall back if denied
  connectHardwareWebcam();

  // 4. Tab Navigation
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetEl = document.getElementById(targetTab);
      if (targetEl) targetEl.classList.add('active');
    });
  });

  // 5. Detect and Connect to Google Meet Tabs
  function detectMeetTabs() {
    if (!chrome.tabs || !chrome.tabs.query) return;

    chrome.tabs.query({ url: '*://meet.google.com/*' }, (tabs) => {
      if (chrome.runtime.lastError) return;

      if (tabs && tabs.length > 0) {
        activeMeetTab = tabs[0];
        meetConnBadge.textContent = 'Meet Active';
        meetConnBadge.style.color = '#4ade80';
        meetConnBadge.style.borderColor = 'rgba(74, 222, 128, 0.4)';
        meetConnBadge.style.background = 'rgba(74, 222, 128, 0.15)';

        meetSyncText.innerHTML = `Connected to Google Meet call (${tabs.length} tab)`;
        btnFocusMeet.style.display = 'block';
        btnFocusMeet.onclick = () => {
          chrome.tabs.update(activeMeetTab.id, { active: true });
        };

        // Query state from content script
        chrome.tabs.sendMessage(activeMeetTab.id, { action: 'GET_MEET_STATE' }, (response) => {
          if (chrome.runtime.lastError || !response) return;
          if (response.cameraState) {
            updateCameraModeUI(response.cameraState.mode, response.cameraState.progressSec);
          }
          if (response.transcriptLog && response.transcriptLog.length > 0) {
            transcripts = response.transcriptLog;
            renderTranscripts();
          }
        });
      } else {
        meetConnBadge.textContent = 'Ready';
        meetSyncText.textContent = 'Ready for Google Meet (Standalone Mode)';
        btnFocusMeet.style.display = 'none';
      }
    });
  }

  detectMeetTabs();

  // Safely forward camera command to Google Meet
  function forwardCommandToMeet(command) {
    if (!activeMeetTab) return;
    chrome.tabs.sendMessage(activeMeetTab.id, { action: 'TRIGGER_CAM_CMD', command }, (res) => {
      if (chrome.runtime.lastError) {
        // Tab might be navigating, ignore
      }
    });
  }

  // 6. Action: Freeze Camera
  async function handleFreezeAction() {
    const source = (isUsingRealWebcam && popupVideo && popupVideo.readyState >= 2) ? popupVideo : popupCanvas;
    if (frozenSnapshot) freeSnapshot(frozenSnapshot);
    frozenSnapshot = await captureSnapshot(source, popupCanvas.width, popupCanvas.height);

    updateCameraModeUI('frozen');
    forwardCommandToMeet('FREEZE');
    showToast('❄ Camera feed frozen on current frame!');
  }

  btnFreeze.addEventListener('click', handleFreezeAction);

  // 7. Action: 15s Video Loop (Instant from Rolling Buffer)
  async function startInstantLoop() {
    const source = (isUsingRealWebcam && popupVideo && popupVideo.readyState >= 2) ? popupVideo : popupCanvas;

    if (rollingBuffer.length >= 8) {
      // Immediate loop from rolling buffer!
      clearFramesArray(loopFrames);
      for (const snap of rollingBuffer) {
        if (snap.type === 'bitmap' && snap.data) {
          const cloneBmp = await window.createImageBitmap(snap.data);
          loopFrames.push({ type: 'bitmap', data: cloneBmp });
        } else if (snap.type === 'imagedata' && snap.data) {
          const clonedData = new ImageData(
            new Uint8ClampedArray(snap.data.data),
            snap.data.width,
            snap.data.height
          );
          loopFrames.push({ type: 'imagedata', data: clonedData });
        }
      }
      currentCamMode = 'looping';
      loopStartTime = Date.now();
      updateCameraModeUI('looping');
      forwardCommandToMeet('INSTANT_LOOP');
      showToast(`🔄 Instant 15s loop playing seamlessly! (${loopFrames.length} frames)`);
    } else {
      // Buffer still initializing, start quick capture
      start15sLoopRecording();
    }
  }

  btnLoop.addEventListener('click', () => {
    if (currentCamMode === 'looping' || currentCamMode === 'recording') {
      resumeLiveFeed();
    } else {
      startInstantLoop();
    }
  });

  // Dedicated 15s Recording with Progress
  function start15sLoopRecording() {
    updateCameraModeUI('recording', 0);
    clearFramesArray(loopFrames);

    const totalFramesNeeded = LOOP_DURATION_SEC * (1000 / FRAME_INTERVAL_MS);
    let framesCaptured = 0;

    if (loopRecordInterval) clearInterval(loopRecordInterval);

    forwardCommandToMeet('RECORD_LOOP');
    showToast('🔴 Recording fresh 15s clip... Look at screen or nod.');

    loopRecordInterval = setInterval(async () => {
      if (currentCamMode !== 'recording') {
        clearInterval(loopRecordInterval);
        loopRecordInterval = null;
        return;
      }

      const source = (isUsingRealWebcam && popupVideo && popupVideo.readyState >= 2) ? popupVideo : popupCanvas;
      const snap = await captureSnapshot(source, popupCanvas.width, popupCanvas.height);
      if (snap) {
        loopFrames.push(snap);
        framesCaptured++;
      }

      const currentSec = Math.min(LOOP_DURATION_SEC, Math.floor((framesCaptured * FRAME_INTERVAL_MS) / 1000));
      updateCameraModeUI('recording', currentSec);

      // Finished capturing 15 seconds!
      if (framesCaptured >= totalFramesNeeded || currentSec >= LOOP_DURATION_SEC) {
        clearInterval(loopRecordInterval);
        loopRecordInterval = null;
        currentCamMode = 'looping';
        loopStartTime = Date.now();
        updateCameraModeUI('looping');
        showToast(`🔄 15-second loop is now playing continuously! (${loopFrames.length} frames)`);
      }
    }, FRAME_INTERVAL_MS);
  }

  if (btnRecordNew) {
    btnRecordNew.addEventListener('click', () => {
      start15sLoopRecording();
    });
  }

  // 8. Action: Live Cam
  btnLive.addEventListener('click', () => {
    resumeLiveFeed();
  });

  function resumeLiveFeed() {
    if (loopRecordInterval) {
      clearInterval(loopRecordInterval);
      loopRecordInterval = null;
    }
    clearFramesArray(loopFrames);
    if (frozenSnapshot) {
      freeSnapshot(frozenSnapshot);
      frozenSnapshot = null;
    }
    updateCameraModeUI('live');
    forwardCommandToMeet('RESUME_LIVE');
    showToast('● Resumed live camera stream.');
  }

  // 9. Update UI States
  function updateCameraModeUI(mode, sec = 0) {
    currentCamMode = mode;
    btnLive.classList.remove('active');
    btnFreeze.classList.remove('active');
    btnLoop.classList.remove('active');
    stageBadge.className = `cam-overlay-badge ${mode}`;

    if (mode === 'recording') {
      btnLoop.classList.add('active');
      loopBtnLabel.textContent = `Rec (${sec}s)`;
      stageBadge.innerHTML = `<span>● RECORDING (${sec}/15s)</span>`;
      telemetryState.textContent = 'RECORDING (15s BUFFER)';
      telemetryState.style.color = '#f87171';
      recBar.style.display = 'block';
      recFill.style.width = `${Math.min(100, Math.round((sec / LOOP_DURATION_SEC) * 100))}%`;
      modeDescription.textContent = 'Recording your presence. Look at the screen or nod gently for 15 seconds to create a seamless loop.';
    } else if (mode === 'looping') {
      btnLoop.classList.add('active');
      loopBtnLabel.textContent = 'Exit Loop';
      stageBadge.innerHTML = '<span>🔄 15s LOOP ACTIVE</span>';
      telemetryState.textContent = `15s LOOP ACTIVE (${loopFrames.length || 225} FRAMES)`;
      telemetryState.style.color = '#c084fc';
      recBar.style.display = 'none';
      modeDescription.textContent = 'The 15-second recorded loop is continuously playing through your camera feed to keep you visibly present in Google Meet.';
    } else if (mode === 'frozen') {
      btnFreeze.classList.add('active');
      loopBtnLabel.textContent = '15s Loop';
      stageBadge.innerHTML = '<span>❄ FROZEN FRAME</span>';
      telemetryState.textContent = 'FROZEN (STEPPED AWAY)';
      telemetryState.style.color = '#2dd4bf';
      recBar.style.display = 'none';
      modeDescription.textContent = 'Camera is locked on the frozen snapshot frame. You can step away from your computer without showing an empty chair or black screen.';
    } else {
      btnLive.classList.add('active');
      loopBtnLabel.textContent = '15s Loop';
      stageBadge.innerHTML = '<span>● LIVE FEED</span>';
      telemetryState.textContent = 'LIVE (READY)';
      telemetryState.style.color = '#4ade80';
      recBar.style.display = 'none';
      modeDescription.textContent = 'Camera feed is live. Click Freeze Frame to pause when stepping away, or 15s Loop to record and play an active presence clip.';
    }
  }

  // 10. Load and Save Settings (API Key & Shortcuts)
  function updateKeybindUI() {
    if (popBadgeLive) popBadgeLive.textContent = liveKey;
    if (popBadgeFreeze) popBadgeFreeze.textContent = freezeKey;
    if (btnRebindFreeze) btnRebindFreeze.textContent = freezeKey;
    if (btnRebindLive) btnRebindLive.textContent = liveKey;
    if (mouseOverrideNotice) {
      const hasMouse = freezeKey.toLowerCase().includes('mouse') || liveKey.toLowerCase().includes('mouse');
      mouseOverrideNotice.style.display = hasMouse ? 'block' : 'none';
    }
  }

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['geminiApiKey', 'storedTranscripts', 'phantomcamFreezeKey', 'phantomcamLiveKey'], (res) => {
      if (res) {
        if (res.geminiApiKey) {
          customApiKey = res.geminiApiKey;
          customApiKeyInput.value = customApiKey;
        }
        if (res.phantomcamFreezeKey) {
          freezeKey = res.phantomcamFreezeKey;
        }
        if (res.phantomcamLiveKey) {
          liveKey = res.phantomcamLiveKey;
        }
        updateKeybindUI();
        if (res.storedTranscripts && Array.isArray(res.storedTranscripts)) {
          transcripts = res.storedTranscripts;
          renderTranscripts();
        }
      }
    });
  }

  btnSaveKey.addEventListener('click', () => {
    const key = customApiKeyInput.value.trim();
    customApiKey = key;
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      saveConfirmMsg.style.display = 'block';
      showToast('Settings saved successfully!');
      setTimeout(() => {
        saveConfirmMsg.style.display = 'none';
      }, 2500);
    });
  });

  // Keybind Rebinding Handlers
  if (btnRebindFreeze) {
    btnRebindFreeze.addEventListener('click', () => {
      if (recordingKeyFor === 'freeze') {
        recordingKeyFor = null;
        btnRebindFreeze.classList.remove('recording');
        btnRebindFreeze.textContent = freezeKey;
        return;
      }
      recordingKeyFor = 'freeze';
      btnRebindFreeze.classList.add('recording');
      btnRebindFreeze.textContent = 'Click mouse/key...';
      if (btnRebindLive) {
        btnRebindLive.classList.remove('recording');
        btnRebindLive.textContent = liveKey;
      }
      if (keyCollisionWarning) keyCollisionWarning.style.display = 'none';
    });
  }

  if (btnRebindLive) {
    btnRebindLive.addEventListener('click', () => {
      if (recordingKeyFor === 'live') {
        recordingKeyFor = null;
        btnRebindLive.classList.remove('recording');
        btnRebindLive.textContent = liveKey;
        return;
      }
      recordingKeyFor = 'live';
      btnRebindLive.classList.add('recording');
      btnRebindLive.textContent = 'Click mouse/key...';
      if (btnRebindFreeze) {
        btnRebindFreeze.classList.remove('recording');
        btnRebindFreeze.textContent = freezeKey;
      }
      if (keyCollisionWarning) keyCollisionWarning.style.display = 'none';
    });
  }

  if (btnPresetMouse) {
    btnPresetMouse.addEventListener('click', () => {
      recordingKeyFor = null;
      freezeKey = 'Mouse 3';
      liveKey = 'Mouse 4';
      if (btnRebindFreeze) btnRebindFreeze.classList.remove('recording');
      if (btnRebindLive) btnRebindLive.classList.remove('recording');
      if (keyCollisionWarning) keyCollisionWarning.style.display = 'none';
      updateKeybindUI();
      saveKeybinds();
      showToast('Bound Mouse 3 (Freeze) & Mouse 4 (Live)!');
    });
  }

  if (btnResetKeybinds) {
    btnResetKeybinds.addEventListener('click', () => {
      recordingKeyFor = null;
      freezeKey = 'F';
      liveKey = 'L';
      if (btnRebindFreeze) btnRebindFreeze.classList.remove('recording');
      if (btnRebindLive) btnRebindLive.classList.remove('recording');
      if (keyCollisionWarning) keyCollisionWarning.style.display = 'none';
      updateKeybindUI();
      saveKeybinds();
    });
  }

  function saveKeybinds() {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        phantomcamFreezeKey: freezeKey,
        phantomcamLiveKey: liveKey
      }, () => {
        if (keySaveConfirmMsg) {
          keySaveConfirmMsg.style.display = 'block';
          setTimeout(() => {
            keySaveConfirmMsg.style.display = 'none';
          }, 2400);
        }
        showToast(`Shortcuts set: Freeze [${freezeKey}], Live [${liveKey}]`);
      });
    }
  }

  // Intercept and override Mouse Button 3 (Back) and Mouse Button 4 (Forward) inside Popup
  window.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const mouseKeyName = e.button === 3 ? 'Mouse 3' : 'Mouse 4';

      if (recordingKeyFor) {
        if (recordingKeyFor === 'freeze') {
          if (mouseKeyName === liveKey) {
            if (keyCollisionWarning) keyCollisionWarning.style.display = 'block';
            return;
          }
          freezeKey = mouseKeyName;
          if (btnRebindFreeze) btnRebindFreeze.classList.remove('recording');
          recordingKeyFor = null;
          updateKeybindUI();
          saveKeybinds();
        } else if (recordingKeyFor === 'live') {
          if (mouseKeyName === freezeKey) {
            if (keyCollisionWarning) keyCollisionWarning.style.display = 'block';
            return;
          }
          liveKey = mouseKeyName;
          if (btnRebindLive) btnRebindLive.classList.remove('recording');
          recordingKeyFor = null;
          updateKeybindUI();
          saveKeybinds();
        }
        return;
      }

      // Normal trigger
      const isFreeze = freezeKey.toLowerCase().replace(/[\s_\-]/g, '') === `mouse${e.button}`;
      const isLive = liveKey.toLowerCase().replace(/[\s_\-]/g, '') === `mouse${e.button}`;

      if (isFreeze) {
        handleFreezeAction();
        showToast(`Camera Frozen via [Mouse ${e.button}]`);
      } else if (isLive) {
        resumeLiveFeed();
        showToast(`Camera Live via [Mouse ${e.button}]`);
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

  // Window key listener inside popup (for rebind capture & instant trigger)
  window.addEventListener('keydown', (e) => {
    if (recordingKeyFor) {
      e.preventDefault();
      e.stopPropagation();

      // Skip modifier keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      const newKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;

      if (recordingKeyFor === 'freeze') {
        if (newKey === liveKey) {
          if (keyCollisionWarning) keyCollisionWarning.style.display = 'block';
          return;
        }
        freezeKey = newKey;
        if (btnRebindFreeze) btnRebindFreeze.classList.remove('recording');
        recordingKeyFor = null;
        updateKeybindUI();
        saveKeybinds();
      } else if (recordingKeyFor === 'live') {
        if (newKey === freezeKey) {
          if (keyCollisionWarning) keyCollisionWarning.style.display = 'block';
          return;
        }
        liveKey = newKey;
        if (btnRebindLive) btnRebindLive.classList.remove('recording');
        recordingKeyFor = null;
        updateKeybindUI();
        saveKeybinds();
      }
      return;
    }

    // Normal typing guard
    const target = e.target;
    if (
      target && (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable
      )
    ) {
      return;
    }

    const pressed = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!freezeKey.toLowerCase().includes('mouse') && pressed === freezeKey.toUpperCase()) {
      e.preventDefault();
      handleFreezeAction();
      showToast(`Camera Frozen via [${freezeKey}]`);
    } else if (!liveKey.toLowerCase().includes('mouse') && pressed === liveKey.toUpperCase()) {
      e.preventDefault();
      resumeLiveFeed();
      showToast(`Camera Live via [${liveKey}]`);
    }
  });

  // 11. Transcripts Management
  function renderTranscripts() {
    const q = transcriptSearch.value.toLowerCase();
    const list = transcripts.filter(t => 
      t.text.toLowerCase().includes(q) || (t.speaker && t.speaker.toLowerCase().includes(q))
    );

    turnsCount.textContent = `${transcripts.length} turns logged`;

    if (!list || list.length === 0) {
      transcriptsContainer.innerHTML = `
        <div style="text-align: center; color: #64748b; font-style: italic; padding: 40px 10px;">
          ${q ? 'No matching dialogue turns.' : 'Join Google Meet and turn on Closed Captions (CC), or click "Simulate" to test live dialogue...'}
        </div>
      `;
      return;
    }

    transcriptsContainer.innerHTML = list.map(t => `
      <div class="transcript-turn">
        <div class="turn-speaker">
          <span>${escapeHtml(t.speaker || 'Speaker')}</span>
          <span class="turn-time">${t.time || ''}</span>
        </div>
        <div>${escapeHtml(t.text)}</div>
      </div>
    `).join('');

    transcriptsContainer.scrollTop = transcriptsContainer.scrollHeight;
  }

  transcriptSearch.addEventListener('input', renderTranscripts);

  btnSimulate.addEventListener('click', () => {
    const sampleDialogue = [
      { speaker: 'Sarah Jenkins (Eng Lead)', text: 'Welcome everyone. Let us review the Q4 deliverables and video looping pipeline.' },
      { speaker: 'David Park (Architecture)', text: 'WebRTC getUserMedia replacement is executing with zero latency overhead.' },
      { speaker: 'Elena Rostova (Product)', text: 'Feedback on the 15-second loop and camera freeze features has been outstanding.' }
    ];

    sampleDialogue.forEach((item, idx) => {
      setTimeout(() => {
        transcripts.push({
          ...item,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        renderTranscripts();
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ storedTranscripts: transcripts });
        }
      }, idx * 450);
    });
  });

  btnClearTranscripts.addEventListener('click', () => {
    transcripts = [];
    renderTranscripts();
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ storedTranscripts: [] });
    }
    // Also clear the live log in the Meet tab, otherwise its next status sync
    // would immediately repopulate the list.
    if (activeMeetTab) {
      chrome.tabs.sendMessage(activeMeetTab.id, { action: 'CLEAR_TRANSCRIPTS' }, () => {
        void chrome.runtime.lastError;
      });
    }
  });

  // 12. Gemini AI Meeting Summarization
  btnGenerateSummary.addEventListener('click', async () => {
    if (transcripts.length === 0) {
      showToast('Please simulate or log dialogue turns before summarizing.');
      return;
    }

    btnGenerateSummary.disabled = true;
    btnGenerateSummary.innerHTML = '<span>⏳ Gemini is generating meeting brief...</span>';
    summaryOutput.innerHTML = 'Analyzing dialogue turns and extracting action items...';

    const textLog = transcripts.map(t => `[${t.time || ''}] ${t.speaker || 'Speaker'}: ${t.text}`).join('\n');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'GEMINI_SUMMARIZE',
        transcript: textLog,
        apiKey: customApiKey || undefined
      });

      if (response?.ok) {
        summaryOutput.textContent = response.text;
      } else if (response?.error === 'MISSING_API_KEY') {
        summaryOutput.innerHTML = `⚠️ <strong>Gemini API key required.</strong><br/><br/>` +
          `Open the <strong>Settings</strong> tab and paste a key from ` +
          `<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. ` +
          `The key is stored locally in this browser and is sent only to the Gemini API.`;
      } else {
        summaryOutput.textContent = `Error: ${response?.error || 'unknown error'}. Please verify your API key in Settings.`;
      }
    } catch (e) {
      summaryOutput.textContent = `Error: ${e.message}. Please verify your API key in Settings.`;
    } finally {
      btnGenerateSummary.disabled = false;
      btnGenerateSummary.innerHTML = '<span>✨ Generate Executive Summary & Action Items</span>';
    }
  });

  btnCopySummary.addEventListener('click', () => {
    if (summaryOutput.innerText) {
      navigator.clipboard.writeText(summaryOutput.innerText);
      btnCopySummary.textContent = 'Copied!';
      setTimeout(() => {
        btnCopySummary.textContent = 'Copy';
      }, 2000);
    }
  });

  // 13. External Navigation Links
  linkOpenMeet.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://meet.google.com/new' });
  });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }
});
