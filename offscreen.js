const video = document.getElementById('capture');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

let stream = null;
let encoder = null;
let captureTimer = null;
let activeOptions = null;
let stopping = false;
let blobUrls = new Set();

function waitForMetadata() {
  if (video.readyState >= 1 && video.videoWidth && video.videoHeight) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Could not read the captured tab video.'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function calculateSize(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale))
  };
}

function captureFrame() {
  if (!stream || !encoder || stopping || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  encoder.addFrame(frame.data);
}

async function startRecording(streamId, options) {
  if (stream) throw new Error('A recording is already active.');

  activeOptions = {
    fps: options?.fps || 8,
    maxWidth: options?.maxWidth || 960,
    maxHeight: options?.maxHeight || 720
  };

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  const [track] = stream.getVideoTracks();
  track.addEventListener('ended', () => {
    if (!stopping && stream) {
      stopRecording().catch((error) => {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'RECORDING_FAILED',
          error: error.message || String(error)
        });
      });
    }
  });

  video.srcObject = stream;
  await waitForMetadata();
  await video.play();

  const size = calculateSize(
    video.videoWidth,
    video.videoHeight,
    activeOptions.maxWidth,
    activeOptions.maxHeight
  );

  canvas.width = size.width;
  canvas.height = size.height;
  encoder = new GifEncoder(size.width, size.height, activeOptions.fps);

  // Capture the initial frame immediately, then continue at the target FPS.
  captureFrame();
  captureTimer = setInterval(captureFrame, Math.round(1000 / activeOptions.fps));

  return { width: size.width, height: size.height, fps: activeOptions.fps };
}

function buildFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `tab-recording-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.gif`;
}

async function stopRecording() {
  if (!stream || !encoder) return { frameCount: 0 };
  if (stopping) return { frameCount: encoder.frameCount };

  stopping = true;
  clearInterval(captureTimer);
  captureTimer = null;

  // Add one final frame if possible.
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    encoder.addFrame(frame.data);
  }

  for (const track of stream.getTracks()) track.stop();
  video.pause();
  video.srcObject = null;

  const frameCount = encoder.frameCount;
  const blob = encoder.finish();
  const blobUrl = URL.createObjectURL(blob);
  blobUrls.add(blobUrl);
  const filename = buildFilename();

  stream = null;
  encoder = null;
  activeOptions = null;
  stopping = false;

  const result = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'GIF_READY',
    blobUrl,
    filename,
    frameCount,
    bytes: blob.size
  });

  if (!result?.ok) {
    URL.revokeObjectURL(blobUrl);
    blobUrls.delete(blobUrl);
    throw new Error(result?.error || 'Could not start GIF download.');
  }

  return { frameCount, bytes: blob.size };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'START_RECORDING') {
    startRecording(message.streamId, message.options)
      .then((details) => sendResponse({ ok: true, ...details }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    stopRecording()
      .then((details) => sendResponse({ ok: true, ...details }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'RELEASE_BLOB') {
    if (message.blobUrl && blobUrls.has(message.blobUrl)) {
      URL.revokeObjectURL(message.blobUrl);
      blobUrls.delete(message.blobUrl);
    }
    sendResponse({ ok: true });
  }
});
