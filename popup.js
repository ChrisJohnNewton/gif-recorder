const button = document.getElementById('recordButton');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const dot = document.getElementById('dot');

let state = null;
let busy = false;

function formatDuration(startedAt) {
  if (!startedAt) return '00:00';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function render() {
  if (!state) return;

  dot.classList.toggle('recording', state.recording);

  if (busy) {
    button.disabled = true;
    return;
  }

  if (state.recording) {
    statusEl.textContent = `Recording ${formatDuration(state.startedAt)}`;
    button.textContent = 'Stop recording';
    button.classList.add('stop');
    button.disabled = false;
    hintEl.textContent = 'Click Stop to create and download the GIF.';
    return;
  }

  if (state.processing) {
    statusEl.textContent = 'Finishing GIF…';
    button.textContent = 'Finishing…';
    button.classList.remove('stop');
    button.disabled = true;
    hintEl.textContent = 'The download will start automatically.';
    return;
  }

  button.textContent = 'Start recording';
  button.classList.remove('stop');
  button.disabled = false;

  if (state.error) {
    statusEl.textContent = state.error;
    hintEl.textContent = 'Try a normal web page; Chrome internal pages cannot be captured.';
  } else if (state.lastFilename && state.lastSavedAt && Date.now() - state.lastSavedAt < 15000) {
    statusEl.textContent = 'Saved to Downloads';
    hintEl.textContent = state.lastFilename;
  } else {
    statusEl.textContent = 'Ready';
    hintEl.textContent = 'Records the visible area of this tab at 8 FPS.';
  }
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    if (response?.ok) {
      state = response.state;
      render();
    }
  } catch (_) {
    statusEl.textContent = 'Could not reach recorder.';
  }
}

button.addEventListener('click', async () => {
  if (!state || busy) return;
  busy = true;
  button.disabled = true;

  try {
    if (state.recording) {
      statusEl.textContent = 'Finishing GIF…';
      const response = await chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
      if (!response?.ok) throw new Error(response?.error || 'Could not stop recording.');
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found.');

      statusEl.textContent = 'Starting…';
      const response = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        tabId: tab.id
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not start recording.');
    }
  } catch (error) {
    statusEl.textContent = error.message || String(error);
  } finally {
    busy = false;
    await refreshState();
  }
});

refreshState();
setInterval(refreshState, 500);
