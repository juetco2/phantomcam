/**
 * Google Meet Virtual Camera & Loop Injector
 * Injected into Google Meet's MAIN page context at document_start.
 * Intercepts navigator.mediaDevices.getUserMedia to seamlessly control what
 * Google Meet and all other meeting participants see:
 * - Live real webcam
 * - Instant Freeze Frame (actively encoded at 30 FPS to prevent remote dropouts)
 * - 15-second Rolling Video Loop (ImageBitmap / Context-safe buffer with zero lag or context loss)
 */
(() => {
  if (window.__MEET_COPILOT_INJECTED__) return;
  window.__MEET_COPILOT_INJECTED__ = true;

  console.log('%c[PhantomCam] Virtual Camera Injector initialized in MAIN page world.', 'color: #38bdf8; font-weight: bold;');

  // Store original getUserMedia
  const originalGetUserMedia = MediaDevices.prototype.getUserMedia 
    ? MediaDevices.prototype.getUserMedia.bind(navigator.mediaDevices)
    : navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  // Core State
  let currentMode = 'live'; // 'live' | 'recording' | 'looping' | 'frozen'
  let rawStream = null;
  let virtualStream = null;
  let animFrameId = null;

  // Offscreen Video & Canvas Pipeline
  const rawVideo = document.createElement('video');
  rawVideo.muted = true;
  rawVideo.playsInline = true;
  rawVideo.autoplay = true;
  rawVideo.style.position = 'fixed';
  rawVideo.style.top = '0';
  rawVideo.style.left = '0';
  rawVideo.style.width = '2px';
  rawVideo.style.height = '2px';
  rawVideo.style.opacity = '0.001';
  rawVideo.style.pointerEvents = 'none';
  rawVideo.style.zIndex = '-99999';

  function attachRawVideoToDOM() {
    if (!rawVideo.parentNode) {
      (document.body || document.documentElement).appendChild(rawVideo);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  // Reusable Single Sampler Canvas (for fallback ImageData, avoids 2D context limits)
  let samplerCanvas = null;
  let samplerCtx = null;

  // Freeze Frame snapshot
  let frozenSnapshot = null;

  // Frame Buffer Loop Storage
  // Uses ImageBitmap or single-canvas ImageData to guarantee 100% zero canvas context exhaustion
  let loopFrames = [];
  let rollingBuffer = [];
  const MAX_ROLLING_FRAMES = 120; // ~15 seconds at 8 FPS
  const FRAME_INTERVAL_MS = 125;  // 8 FPS capture
  let rollingSamplerInterval = null;
  let loopStartTime = 0;
  let loopRecordInterval = null;
  const LOOP_DURATION_SEC = 15;

  async function captureSnapshot(source, w = 640, h = 360) {
    if (!source) return null;

    // Method 1: createImageBitmap (Ultra-fast GPU bitmap, zero context allocation)
    if (window.createImageBitmap) {
      try {
        const bmp = await window.createImageBitmap(source, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'medium'
        });
        return { type: 'bitmap', data: bmp };
      } catch (e) {
        // Fall back to Method 2
      }
    }

    // Method 2: Single persistent offscreen canvas with ImageData
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

  // Start continuous rolling buffer in the background
  function startRollingSampler() {
    if (rollingSamplerInterval) return;
    rollingSamplerInterval = setInterval(async () => {
      if (currentMode !== 'live') return;

      const source = (rawVideo.readyState >= 2 && rawVideo.videoWidth > 0) ? rawVideo : canvas;
      const snap = await captureSnapshot(source, 640, 360);
      if (!snap) return;

      rollingBuffer.push(snap);
      if (rollingBuffer.length > MAX_ROLLING_FRAMES) {
        const oldest = rollingBuffer.shift();
        freeSnapshot(oldest);
      }
    }, FRAME_INTERVAL_MS);
  }

  // Continuous 30 FPS Render Loop
  // CRITICAL: Actively paints every single frame even when frozen or looping so Chromium's
  // WebRTC encoder transmits continuous 30 FPS frames to remote participants
  function renderFrame() {
    if (!ctx) return;

    if (currentMode === 'frozen' && frozenSnapshot) {
      // Actively paint frozen snapshot every tick so WebRTC keeps transmitting to remote peers
      drawSnapshot(ctx, frozenSnapshot, canvas.width, canvas.height);
    } else if (currentMode === 'looping' && loopFrames.length > 0) {
      // Seamlessly cycle through captured 15s frame buffer
      const elapsedMs = Date.now() - loopStartTime;
      const frameDurationMs = FRAME_INTERVAL_MS;
      const frameIdx = Math.floor(elapsedMs / frameDurationMs) % loopFrames.length;
      const currentFrame = loopFrames[frameIdx];
      if (currentFrame) {
        drawSnapshot(ctx, currentFrame, canvas.width, canvas.height);
      }
    } else {
      // Live or recording mode: draw raw camera feed. Resolution was locked in
      // when the stream was created; changing it now would alter the track Meet
      // is already consuming.
      if (rawVideo.readyState >= 2) {
        ctx.drawImage(rawVideo, 0, 0, canvas.width, canvas.height);
      }
    }

    animFrameId = requestAnimationFrame(renderFrame);
  }

  // Intercept getUserMedia on both prototype and instance
  async function hookedGetUserMedia(constraints) {
    console.log('[PhantomCam] getUserMedia called with constraints:', constraints);

    // If only audio is requested, pass directly through
    if (!constraints || !constraints.video) {
      return originalGetUserMedia(constraints);
    }

    // Release the previous canvas stream's video track before rebuilding the
    // pipeline, so device switches and camera re-toggles don't leak streams.
    // Audio tracks are deliberately left alone: they belong to the live call.
    if (virtualStream) {
      virtualStream.getVideoTracks().forEach((track) => track.stop());
      virtualStream = null;
    }

    try {
      attachRawVideoToDOM();

      // Acquire real user webcam stream
      rawStream = await originalGetUserMedia(constraints);
      rawVideo.srcObject = rawStream;
      await rawVideo.play().catch(() => {});

      // Align canvas resolution to raw camera input
      if (rawVideo.videoWidth && rawVideo.videoHeight) {
        canvas.width = rawVideo.videoWidth;
        canvas.height = rawVideo.videoHeight;
      }

      // Start continuous active canvas rendering
      if (!animFrameId) {
        animFrameId = requestAnimationFrame(renderFrame);
      }

      // Start background rolling buffer
      startRollingSampler();

      // Capture active virtual stream at 30 FPS
      virtualStream = canvas.captureStream(30);

      // Preserve audio tracks if requested
      const audioTracks = rawStream.getAudioTracks();
      audioTracks.forEach(track => {
        virtualStream.addTrack(track);
      });

      // Synchronize track capabilities so Google Meet treats virtual stream as real webcam
      const realVideoTrack = rawStream.getVideoTracks()[0];
      const virtualVideoTrack = virtualStream.getVideoTracks()[0];

      if (realVideoTrack && virtualVideoTrack) {
        virtualVideoTrack.applyConstraints = (c) => realVideoTrack.applyConstraints(c);
        if (realVideoTrack.getSettings) {
          const origSettings = virtualVideoTrack.getSettings.bind(virtualVideoTrack);
          virtualVideoTrack.getSettings = () => ({
            ...realVideoTrack.getSettings(),
            ...origSettings()
          });
        }
      }

      console.log('[PhantomCam] Successfully attached virtual camera stream to Google Meet.');
      notifyStatus();
      return virtualStream;
    } catch (err) {
      console.warn('[PhantomCam] Error in virtual camera interceptor, falling back to original stream:', err);
      return originalGetUserMedia(constraints);
    }
  }

  // Install hook on both prototype and navigator.mediaDevices
  try {
    MediaDevices.prototype.getUserMedia = hookedGetUserMedia;
    navigator.mediaDevices.getUserMedia = hookedGetUserMedia;
  } catch (e) {
    navigator.mediaDevices.getUserMedia = hookedGetUserMedia;
  }

  // Action: Freeze Frame
  async function freezeCamera() {
    const source = (rawVideo.readyState >= 2 && rawVideo.videoWidth > 0) ? rawVideo : canvas;
    if (frozenSnapshot) freeSnapshot(frozenSnapshot);
    frozenSnapshot = await captureSnapshot(source, canvas.width, canvas.height);
    currentMode = 'frozen';
    console.log('[PhantomCam] Camera FROZEN for all participants in call.');
    notifyStatus();
  }

  // Action: Instant Loop (Uses rolling buffer immediately without waiting 15 seconds)
  async function startInstantLoop() {
    if (rollingBuffer.length >= 10) {
      // We already have a continuous rolling 15s buffer! Start looping immediately!
      clearFramesArray(loopFrames);
      // Clone bitmaps/imagedata from rollingBuffer into loopFrames
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
      currentMode = 'looping';
      loopStartTime = Date.now();
      console.log(`[PhantomCam] Instant 15s loop started immediately with ${loopFrames.length} frames.`);
      notifyStatus(LOOP_DURATION_SEC);
    } else {
      // Buffer not full yet, do dedicated 15s capture
      start15sLoopRecording();
    }
  }

  // Action: Dedicated 15-Second Loop Recorder
  function start15sLoopRecording() {
    currentMode = 'recording';
    clearFramesArray(loopFrames);
    notifyStatus(0);

    const totalFramesNeeded = LOOP_DURATION_SEC * (1000 / FRAME_INTERVAL_MS);
    let framesCaptured = 0;

    if (loopRecordInterval) clearInterval(loopRecordInterval);

    loopRecordInterval = setInterval(async () => {
      if (currentMode !== 'recording') {
        clearInterval(loopRecordInterval);
        loopRecordInterval = null;
        return;
      }

      const source = (rawVideo.readyState >= 2 && rawVideo.videoWidth > 0) ? rawVideo : canvas;
      const snap = await captureSnapshot(source, 640, 360);
      if (snap) {
        loopFrames.push(snap);
        framesCaptured++;
      }

      const currentSec = Math.min(LOOP_DURATION_SEC, Math.floor((framesCaptured * FRAME_INTERVAL_MS) / 1000));
      notifyStatus(currentSec);

      // Completion of 15 seconds
      if (framesCaptured >= totalFramesNeeded || currentSec >= LOOP_DURATION_SEC) {
        clearInterval(loopRecordInterval);
        loopRecordInterval = null;
        currentMode = 'looping';
        loopStartTime = Date.now();
        console.log(`[PhantomCam] 15-second loop recorded with ${loopFrames.length} frames. Looping continuously.`);
        notifyStatus(LOOP_DURATION_SEC);
      }
    }, FRAME_INTERVAL_MS);
  }

  // Action: Resume Live Stream
  function resumeLive() {
    if (loopRecordInterval) {
      clearInterval(loopRecordInterval);
      loopRecordInterval = null;
    }
    clearFramesArray(loopFrames);
    if (frozenSnapshot) {
      freeSnapshot(frozenSnapshot);
      frozenSnapshot = null;
    }
    currentMode = 'live';
    console.log('[PhantomCam] Resumed live camera stream.');
    notifyStatus();
  }

  function notifyStatus(progressSec = 0) {
    window.postMessage({
      source: 'meet-copilot-injector',
      type: 'STATUS_UPDATE',
      data: {
        mode: currentMode,
        hasStream: !!rawStream,
        progressSec,
        totalSec: LOOP_DURATION_SEC,
        frameCount: loopFrames.length,
        rollingCount: rollingBuffer.length
      }
    }, '*');
  }

  // Listen for commands from content.js or extension popup
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'meet-copilot-content') return;

    const { command } = event.data;
    console.log('[PhantomCam] Injector received command:', command);

    switch (command) {
      case 'FREEZE':
        freezeCamera();
        break;
      case 'INSTANT_LOOP':
        startInstantLoop();
        break;
      case 'RECORD_LOOP':
        start15sLoopRecording();
        break;
      case 'RESUME_LIVE':
        resumeLive();
        break;
      case 'GET_STATUS':
        notifyStatus();
        break;
    }
  });

  // Ensure DOM attachment when document becomes ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachRawVideoToDOM);
  } else {
    attachRawVideoToDOM();
  }

  console.log('[PhantomCam] Injector setup complete.');
})();
