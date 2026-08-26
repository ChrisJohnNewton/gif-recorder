const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_STATE = {
  recording: false,
  processing: false,
  tabId: null,
  startedAt: null,
  lastFilename: null,
  lastSavedAt: null,
  error: null
};

let creatingOffscreen = null;

async function getState() {
  const { recorderState } = await chrome.storage.session.get('recorderState');
  return { ...DEFAULT_STATE, ...(recorderState || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ recorderState: next });
  return next;
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });

  if (contexts.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Record the active tab and build a GIF Blob for download.'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }

  await creatingOffscreen;
}

async function startRecording(tabId) {
  const state = await getState();
  if (state.recording || state.processing) {
    throw new Error('A recording is already active or being processed.');
  }

  await ensureOffscreenDocument();

  // The stream ID expires quickly, so request it only after the offscreen
  // document is ready to consume it.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const startedAt = Date.now();

  await setState({
    recording: true,
    processing: false,
    tabId,
    startedAt,
    error: null,
    lastFilename: null,
    lastSavedAt: null
  });

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_RECORDING',
      streamId,
      options: {
        fps: 8,
        maxWidth: 960,
        maxHeight: 720
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not start the recorder.');
    }

    return response;
  } catch (error) {
    await setState({
      recording: false,
      processing: false,
      tabId: null,
      startedAt: null,
      error: error.message || String(error)
    });
    throw error;
  }
}

async function stopRecording() {
  const state = await getState();
  if (!state.recording) {
    return { ok: true, alreadyStopped: true };
  }

  await setState({ recording: false, processing: true, error: null });

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_RECORDING'
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not stop the recorder.');
    }

    return response;
  } catch (error) {
    await setState({
      recording: false,
      processing: false,
      tabId: null,
      startedAt: null,
      error: error.message || String(error)
    });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== 'background') return;

  if (message?.type === 'GET_STATE') {
    getState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'START_RECORDING') {
    startRecording(message.tabId)
      .then((details) => sendResponse({ ok: true, ...details }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === 'STOP_RECORDING') {
    stopRecording()
      .then((details) => sendResponse({ ok: true, ...details }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === 'GIF_READY') {
    (async () => {
      const filename = message.filename || `tab-recording-${Date.now()}.gif`;
      try {
        const downloadId = await chrome.downloads.download({
          url: message.blobUrl,
          filename,
          saveAs: false,
          conflictAction: 'uniquify'
        });

        await chrome.storage.session.set({
          pendingGifDownload: {
            id: downloadId,
            blobUrl: message.blobUrl
          }
        });

        await setState({
          recording: false,
          processing: false,
          tabId: null,
          startedAt: null,
          lastFilename: filename,
          lastSavedAt: Date.now(),
          error: null
        });

        sendResponse({ ok: true, downloadId });
      } catch (error) {
        await setState({
          recording: false,
          processing: false,
          tabId: null,
          startedAt: null,
          error: `Download failed: ${error.message || String(error)}`
        });
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === 'RECORDING_FAILED') {
    setState({
      recording: false,
      processing: false,
      tabId: null,
      startedAt: null,
      error: message.error || 'Recording failed.'
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;

  const { pendingGifDownload } = await chrome.storage.session.get('pendingGifDownload');
  if (!pendingGifDownload || pendingGifDownload.id !== delta.id) return;

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'RELEASE_BLOB',
      blobUrl: pendingGifDownload.blobUrl
    });
  } catch (_) {
    // The offscreen document may already be gone; the URL will then be cleaned up automatically.
  }

  await chrome.storage.session.remove('pendingGifDownload');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ recorderState: DEFAULT_STATE });
});
