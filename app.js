/* ==========================================================================
   Posture Monitor — Web Serial Telemetry & Dashboard Logic
   Matches ESP32 firmware: 115200 baud, MPU6050, GPIO 12 Motor, GPIO 4 Button
   ========================================================================== */

(() => {
  'use strict';

  // Firmware constants (mirrored from posture_monitor.ino)
  const BAUD_RATE = 115200;
  const ANGLE_THRESHOLD = 10.0;
  const RECOVERY_THRESHOLD = 3.0;
  const DURATION_THRESHOLD = 5000; // ms
  const MAX_CHART_POINTS = 300;    // ~30s at 10 Hz
  const MAX_LOG_LINES = 250;

  // Regex matching: "Baseline: 0.00 | Current Angle: 12.34 | Signed Deviation: 12.34"
  const TELEMETRY_REGEX =
    /Baseline:\s*([+-]?\d+(?:\.\d+)?)\s*\|\s*Current Angle:\s*([+-]?\d+(?:\.\d+)?)\s*\|\s*Signed Deviation:\s*([+-]?\d+(?:\.\d+)?)/i;

  // DOM references
  const dom = {
    connPill: document.getElementById('connPill'),
    connLabel: document.getElementById('connLabel'),
    btnConnect: document.getElementById('btnConnect'),
    btnDemo: document.getElementById('btnDemo'),
    btnHardware: document.getElementById('btnHardware'),
    serialWarning: document.getElementById('serialWarning'),

    stateBanner: document.getElementById('stateBanner'),
    stateTitle: document.getElementById('stateTitle'),
    stateDesc: document.getElementById('stateDesc'),
    motorBadge: document.getElementById('motorBadge'),
    holdLabel: document.getElementById('holdLabel'),
    holdTime: document.getElementById('holdTime'),
    holdFill: document.getElementById('holdFill'),

    postureSvg: document.getElementById('postureSvg'),
    spineGroup: document.getElementById('spineGroup'),
    spineLine: document.getElementById('spineLine'),
    sensorLed: document.getElementById('sensorLed'),
    svgAngleReadout: document.getElementById('svgAngleReadout'),
    calibrationTag: document.getElementById('calibrationTag'),

    valDeviation: document.getElementById('valDeviation'),
    valCurrent: document.getElementById('valCurrent'),
    valBaseline: document.getElementById('valBaseline'),
    subDeviation: document.getElementById('subDeviation'),

    demoControls: document.getElementById('demoControls'),
    chkAutoSim: document.getElementById('chkAutoSim'),
    simAngleSlider: document.getElementById('simAngleSlider'),
    simSliderVal: document.getElementById('simSliderVal'),
    btnSimCalibrate: document.getElementById('btnSimCalibrate'),
    btnSimSlouch: document.getElementById('btnSimSlouch'),

    chartCanvas: document.getElementById('deviationChart'),
    btnPauseChart: document.getElementById('btnPauseChart'),
    btnClearChart: document.getElementById('btnClearChart'),
    sampleRate: document.getElementById('sampleRate'),

    statUpright: document.getElementById('statUpright'),
    statAlerts: document.getElementById('statAlerts'),
    statPeak: document.getElementById('statPeak'),
    statTime: document.getElementById('statTime'),
    mpuStatusLabel: document.getElementById('mpuStatusLabel'),
    btnExportCsv: document.getElementById('btnExportCsv'),

    serialOutput: document.getElementById('serialOutput'),
    chkAutoScroll: document.getElementById('chkAutoScroll'),
    btnClearLog: document.getElementById('btnClearLog'),

    hardwareModal: document.getElementById('hardwareModal'),
    btnCloseModal: document.getElementById('btnCloseModal'),
  };

  // Application state
  const state = {
    mode: 'idle', // 'idle' | 'serial' | 'demo'
    port: null,
    reader: null,
    readableStreamClosed: null,

    // Posture / firmware mirrored state
    baseline: 0,
    currentAngle: 0,
    deviation: 0,
    isTiming: false,
    badPostureStartTime: 0,
    isVibrating: false,
    mpuStatus: 'Idle',

    // Chart & recording
    chartPaused: false,
    samples: [],        // { t, dev, vibrating, calibrated }
    csvRows: [],        // Recorded session rows
    sampleTimestamps: [],

    // Session metrics
    sessionStart: null,
    totalSamples: 0,
    goodSamples: 0,
    alertCount: 0,
    peakDeviation: 0,

    // Demo simulator internals
    demoTimer: null,
    simTick: 0,
    simBaseline: 2.0,
    simSmoothed: 2.0,
    simTargetRaw: 2.0,
    simIsTiming: false,
    simBadStart: 0,
    simIsVibrating: false,
  };

  /* ------------------------------------------------------------------------
     Utility Helpers
     ------------------------------------------------------------------------ */
  function formatTimeStamp(date = new Date()) {
    return date.toTimeString().slice(0, 8);
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function appendLog(message, type = 'normal') {
    const line = document.createElement('div');
    line.className = `log-line${type !== 'normal' ? ` log-${type}` : ''}`;

    const tsSpan = document.createElement('span');
    tsSpan.className = 'log-ts';
    tsSpan.textContent = formatTimeStamp();

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = message;

    line.appendChild(tsSpan);
    line.appendChild(msgSpan);
    dom.serialOutput.appendChild(line);

    while (dom.serialOutput.children.length > MAX_LOG_LINES) {
      dom.serialOutput.removeChild(dom.serialOutput.firstChild);
    }

    if (dom.chkAutoScroll.checked) {
      dom.serialOutput.scrollTop = dom.serialOutput.scrollHeight;
    }
  }

  /* ------------------------------------------------------------------------
     Firmware-Synchronized Serial Line Parser
     ------------------------------------------------------------------------ */
  function handleSerialLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    // 1. MPU6050 status messages
    if (line.includes('MPU6050 connected successfully!')) {
      state.mpuStatus = 'Online';
      dom.mpuStatusLabel.textContent = 'MPU6050: Online';
      appendLog(line, 'event');
      return;
    }

    if (line.includes('MPU6050 connection failed!')) {
      state.mpuStatus = 'Error';
      dom.mpuStatusLabel.textContent = 'MPU6050: Check I²C';
      appendLog(line, 'error');
      return;
    }

    // 2. Calibration event from GPIO 4 button
    if (line.includes('Posture Calibrated!')) {
      state.isTiming = false;
      state.isVibrating = false;
      appendLog(line, 'event');
      triggerCalibrationVisual();
      if (state.samples.length > 0) {
        state.samples[state.samples.length - 1].calibrated = true;
      }
      renderPostureState();
      return;
    }

    // 3. Recovery event
    if (line.includes('Posture corrected! Vibration stopped.')) {
      state.isVibrating = false;
      state.isTiming = false;
      appendLog(line, 'event');
      renderPostureState();
      return;
    }

    // 4. Main telemetry reading line
    const match = line.match(TELEMETRY_REGEX);
    if (match) {
      const baseline = parseFloat(match[1]);
      const currentAngle = parseFloat(match[2]);
      const deviation = parseFloat(match[3]);

      if (Number.isNaN(baseline) || Number.isNaN(currentAngle) || Number.isNaN(deviation)) {
        appendLog(line, 'muted');
        return;
      }

      if (!state.sessionStart) {
        state.sessionStart = Date.now();
      }
      if (state.mpuStatus === 'Idle') {
        state.mpuStatus = 'Online';
        dom.mpuStatusLabel.textContent = 'MPU6050: Online';
      }

      const now = Date.now();
      state.baseline = baseline;
      state.currentAngle = currentAngle;
      state.deviation = deviation;

      // Mirror the exact latching logic in loop()
      const wasVibrating = state.isVibrating;
      if (!state.isVibrating) {
        if (deviation > ANGLE_THRESHOLD) {
          if (!state.isTiming) {
            state.badPostureStartTime = now;
            state.isTiming = true;
          } else if (now - state.badPostureStartTime >= DURATION_THRESHOLD) {
            state.isVibrating = true;
          }
        } else {
          state.isTiming = false;
        }
      } else {
        if (deviation < RECOVERY_THRESHOLD) {
          state.isVibrating = false;
          state.isTiming = false;
        }
      }

      if (!wasVibrating && state.isVibrating) {
        state.alertCount += 1;
        appendLog('[Alert] Continuous slouch >= 5.0s -> Haptic motor ON (GPIO 12 HIGH)', 'warn');
      }

      // Session counters
      state.totalSamples += 1;
      if (!state.isVibrating && deviation <= ANGLE_THRESHOLD) {
        state.goodSamples += 1;
      }
      if (deviation > state.peakDeviation) {
        state.peakDeviation = deviation;
      }

      // Sample rate tracking (1s rolling window)
      state.sampleTimestamps.push(now);
      while (state.sampleTimestamps.length && now - state.sampleTimestamps[0] > 2000) {
        state.sampleTimestamps.shift();
      }

      // Store chart point
      if (!state.chartPaused) {
        state.samples.push({
          t: now,
          dev: deviation,
          vibrating: state.isVibrating,
          calibrated: false,
        });
        if (state.samples.length > MAX_CHART_POINTS) {
          state.samples.shift();
        }
      }

      // Store CSV row
      const statusStr = state.isVibrating
        ? 'VIBRATING'
        : state.isTiming
          ? 'SLOUCH_TIMER'
          : 'UPRIGHT';
      state.csvRows.push([
        new Date(now).toISOString(),
        baseline.toFixed(2),
        currentAngle.toFixed(2),
        deviation.toFixed(2),
        statusStr,
        state.isVibrating ? 1 : 0,
      ]);
      dom.btnExportCsv.disabled = false;

      appendLog(line, state.isVibrating ? 'warn' : 'normal');
      renderPostureState();
      renderStats();
      drawChart();
      return;
    }

    // Any other debug text printed by ESP32
    appendLog(line, 'muted');
  }

  function triggerCalibrationVisual() {
    dom.calibrationTag.classList.add('just-calibrated');
    dom.calibrationTag.textContent = `Calibrated · ${state.baseline.toFixed(1)}°`;
    setTimeout(() => {
      dom.calibrationTag.classList.remove('just-calibrated');
      dom.calibrationTag.textContent = `Baseline ${state.baseline.toFixed(1)}°`;
    }, 1800);
  }

  /* ------------------------------------------------------------------------
     UI Rendering
     ------------------------------------------------------------------------ */
  function renderPostureState() {
    const dev = state.deviation;
    const now = Date.now();

    // Update numeric telemetry readouts
    const sign = dev > 0 ? '+' : '';
    dom.valDeviation.innerHTML = `${sign}${dev.toFixed(2)}<span class="unit">°</span>`;
    dom.valCurrent.innerHTML = `${state.currentAngle.toFixed(2)}<span class="unit">°</span>`;
    dom.valBaseline.innerHTML = `${state.baseline.toFixed(2)}<span class="unit">°</span>`;

    if (!dom.calibrationTag.classList.contains('just-calibrated')) {
      dom.calibrationTag.textContent = `Baseline ${state.baseline.toFixed(1)}°`;
    }

    // Determine visual state
    let status = 'good';
    let holdRatio = 0;
    let holdSeconds = 0;

    if (state.mode === 'idle' && state.totalSamples === 0) {
      status = 'idle';
    } else if (state.isVibrating) {
      status = 'vibrating';
      holdRatio = 1;
      holdSeconds = DURATION_THRESHOLD / 1000;
    } else if (state.isTiming) {
      status = 'warning';
      const elapsed = now - state.badPostureStartTime;
      holdSeconds = Math.min(DURATION_THRESHOLD, elapsed) / 1000;
      holdRatio = clamp(elapsed / DURATION_THRESHOLD, 0, 1);
    } else {
      status = 'good';
      holdRatio = 0;
      holdSeconds = 0;
    }

    dom.stateBanner.dataset.status = status;

    // Reset hero color class
    dom.valDeviation.classList.remove('tone-good', 'tone-warn', 'tone-alert');

    if (status === 'idle') {
      dom.stateTitle.textContent = 'Waiting for sensor data';
      dom.stateDesc.innerHTML =
        'Plug in your ESP32 and click <strong>Connect ESP32</strong>, or start <strong>Demo Mode</strong> to simulate live readings.';
      dom.holdLabel.textContent = 'Slouch duration';
      dom.holdTime.textContent = '0.0s / 5.0s';
      dom.holdFill.style.width = '0%';
      dom.subDeviation.textContent = 'smoothed − baseline';
    } else if (status === 'good') {
      dom.stateTitle.textContent = 'Upright Posture';
      dom.stateDesc.textContent =
        dev < 0
          ? 'Leaning slightly back past baseline. Within safe upright range.'
          : 'Posture is aligned within the 10.0° threshold.';
      dom.holdLabel.textContent = 'Slouch timer';
      dom.holdTime.textContent = '0.0s / 5.0s';
      dom.holdFill.style.width = '0%';
      dom.valDeviation.classList.add('tone-good');
      dom.subDeviation.textContent = 'within 10.0° limit';
    } else if (status === 'warning') {
      const remaining = Math.max(0, 5 - holdSeconds).toFixed(1);
      dom.stateTitle.textContent = 'Slouch Detected';
      dom.stateDesc.textContent = `Deviation above 10.0°. Sit upright within ${remaining}s to avoid haptic vibration.`;
      dom.holdLabel.textContent = 'Slouch hold timer';
      dom.holdTime.textContent = `${holdSeconds.toFixed(1)}s / 5.0s`;
      dom.holdFill.style.width = `${(holdRatio * 100).toFixed(1)}%`;
      dom.valDeviation.classList.add('tone-warn');
      dom.subDeviation.textContent = 'above +10.0° trigger';
    } else if (status === 'vibrating') {
      dom.stateTitle.textContent = 'Haptic Alert Active';
      dom.stateDesc.textContent =
        'Motor latched ON. Straighten your back below 3.0° deviation to stop vibration.';
      dom.holdLabel.textContent = 'Latch active (sit < 3.0° to clear)';
      dom.holdTime.textContent = 'TRIGGERED';
      dom.holdFill.style.width = '100%';
      dom.valDeviation.classList.add('tone-alert');
      dom.subDeviation.textContent = `need < +3.0° to recover`;
    }

    // Motor badge
    dom.motorBadge.dataset.active = state.isVibrating ? 'true' : 'false';
    dom.motorBadge.innerHTML = `<span class="motor-led"></span>GPIO 12: ${
      state.isVibrating ? 'ON' : 'OFF'
    }`;

    // Update SVG posture silhouette
    // Visually amplify rotation by 2.2x so a 10° slouch aligns with the +10° ray drawn at 22°
    const visualAngle = clamp(dev * 2.2, -32, 62);
    dom.spineGroup.setAttribute('transform', `rotate(${visualAngle.toFixed(1)} 145 196)`);
    dom.svgAngleReadout.textContent = `${sign}${dev.toFixed(1)}° dev`;

    const spineColor =
      status === 'vibrating'
        ? '#C43628'
        : status === 'warning'
          ? '#B66810'
          : '#1B7A56';
    dom.spineLine.setAttribute('stroke', spineColor);
    dom.sensorLed.setAttribute(
      'fill',
      status === 'vibrating' ? '#F87171' : status === 'warning' ? '#FBBF24' : '#4ADE80'
    );
    dom.postureSvg.classList.toggle('is-vibrating', state.isVibrating);
  }

  function renderStats() {
    if (state.totalSamples > 0) {
      const pct = Math.round((state.goodSamples / state.totalSamples) * 100);
      dom.statUpright.textContent = `${pct}%`;
    } else {
      dom.statUpright.textContent = '--%';
    }

    dom.statAlerts.textContent = String(state.alertCount);
    dom.statPeak.textContent = `${state.peakDeviation.toFixed(1)}°`;

    if (state.sessionStart) {
      dom.statTime.textContent = formatDuration(Date.now() - state.sessionStart);
    }

    // Compute approximate sample rate over recent window
    const count = state.sampleTimestamps.length;
    if (count >= 2) {
      const spanSec =
        (state.sampleTimestamps[count - 1] - state.sampleTimestamps[0]) / 1000;
      const hz = spanSec > 0 ? (count - 1) / spanSec : 0;
      dom.sampleRate.textContent = `${hz.toFixed(1)} Hz`;
    } else {
      dom.sampleRate.textContent = '0.0 Hz';
    }
  }

  /* ------------------------------------------------------------------------
     Real-time High-DPI Strip Chart (HTML5 Canvas)
     ------------------------------------------------------------------------ */
  function resizeChartCanvas() {
    const canvas = dom.chartCanvas;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(200, Math.floor(rect.width - 32));
    const height = Math.max(150, Math.floor(rect.height - 22));

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function drawChart() {
    const canvas = dom.chartCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    ctx.clearRect(0, 0, W, H);

    const pad = { top: 14, right: 16, bottom: 24, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Determine Y bounds (default -5° to +20°, expands cleanly if needed)
    let yMin = -5;
    let yMax = 20;
    for (const s of state.samples) {
      if (s.dev < yMin + 1) yMin = Math.floor(s.dev / 5) * 5 - 5;
      if (s.dev > yMax - 2) yMax = Math.ceil(s.dev / 5) * 5 + 5;
    }

    const yToPx = (val) => pad.top + ((yMax - val) / (yMax - yMin)) * plotH;
    const xToPx = (idx) =>
      pad.left + (idx / Math.max(1, MAX_CHART_POINTS - 1)) * plotW;

    // Shaded alert zone above +10°
    const y10 = yToPx(ANGLE_THRESHOLD);
    if (y10 > pad.top) {
      ctx.fillStyle = 'rgba(196, 54, 40, 0.055)';
      ctx.fillRect(pad.left, pad.top, plotW, Math.max(0, y10 - pad.top));
    }

    // Horizontal grid lines every 5°
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const step = yMax - yMin > 35 ? 10 : 5;
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const y = yToPx(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.strokeStyle = v === 0 ? '#D4D0C5' : '#EFECE4';
      ctx.lineWidth = v === 0 ? 1.2 : 1;
      ctx.stroke();

      ctx.fillStyle = '#84888E';
      ctx.fillText(`${v}°`, pad.left - 8, y);
    }

    // +3° Recovery reference line
    const y3 = yToPx(RECOVERY_THRESHOLD);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y3);
    ctx.lineTo(pad.left + plotW, y3);
    ctx.strokeStyle = 'rgba(27, 122, 86, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // +10° Slouch trigger reference line
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y10);
    ctx.lineTo(pad.left + plotW, y10);
    ctx.strokeStyle = 'rgba(196, 54, 40, 0.8)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    // Bottom axis labels
    ctx.fillStyle = '#9A9EA4';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('-30s', pad.left, pad.top + plotH + 7);
    ctx.textAlign = 'center';
    ctx.fillText('-15s', pad.left + plotW / 2, pad.top + plotH + 7);
    ctx.textAlign = 'right';
    ctx.fillText('Now', pad.left + plotW, pad.top + plotH + 7);

    // Empty state hint
    if (state.samples.length === 0) {
      ctx.fillStyle = '#9A9EA4';
      ctx.font = '13px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        'Live deviation trace will appear here once data streams in',
        pad.left + plotW / 2,
        pad.top + plotH / 2
      );
      return;
    }

    // Align samples to the right edge of the 30s window
    const offset = MAX_CHART_POINTS - state.samples.length;

    // Calibration vertical markers
    for (let i = 0; i < state.samples.length; i++) {
      if (state.samples[i].calibrated) {
        const x = xToPx(offset + i);
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.strokeStyle = '#4F6D9A';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Subtle fill under line to 0°
    const yZero = clamp(yToPx(0), pad.top, pad.top + plotH);
    ctx.beginPath();
    state.samples.forEach((s, i) => {
      const x = xToPx(offset + i);
      const y = clamp(yToPx(s.dev), pad.top, pad.top + plotH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastX = xToPx(offset + state.samples.length - 1);
    const firstX = xToPx(offset);
    ctx.lineTo(lastX, yZero);
    ctx.lineTo(firstX, yZero);
    ctx.closePath();
    ctx.fillStyle = 'rgba(24, 26, 27, 0.045)';
    ctx.fill();

    // Main trace line
    ctx.beginPath();
    state.samples.forEach((s, i) => {
      const x = xToPx(offset + i);
      const y = clamp(yToPx(s.dev), pad.top, pad.top + plotH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = state.isVibrating
      ? '#C43628'
      : state.isTiming
        ? '#B66810'
        : '#181A1B';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Live endpoint dot
    const lastSample = state.samples[state.samples.length - 1];
    const dotY = clamp(yToPx(lastSample.dev), pad.top, pad.top + plotH);
    ctx.beginPath();
    ctx.arc(lastX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = state.isVibrating
      ? '#C43628'
      : state.isTiming
        ? '#B66810'
        : '#1B7A56';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
  }

  /* ------------------------------------------------------------------------
     Web Serial API Connection (115200 baud)
     ------------------------------------------------------------------------ */
  async function connectSerial() {
    if (!('serial' in navigator)) {
      dom.serialWarning.classList.remove('hidden');
      return;
    }

    // Stop demo mode if running
    if (state.mode === 'demo') {
      stopDemoMode();
    }

    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD_RATE });

      state.port = port;
      state.mode = 'serial';
      resetSessionMetrics();
      updateConnectionUI();
      appendLog(`Connected to ESP32 serial port at ${BAUD_RATE} baud.`, 'event');

      const textDecoder = new TextDecoderStream();
      state.readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      state.reader = reader;

      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop(); // Keep incomplete tail in buffer
          for (const line of lines) {
            handleSerialLine(line);
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        // User dismissed port picker dialog — silent no-op
        return;
      }
      appendLog(
        `Serial connection error: ${err.message || err}. Make sure Arduino Serial Monitor is closed.`,
        'error'
      );
    } finally {
      if (state.mode === 'serial') {
        await disconnectSerial(true);
      }
    }
  }

  async function disconnectSerial(silent = false) {
    try {
      if (state.reader) {
        await state.reader.cancel().catch(() => {});
        state.reader = null;
      }
      if (state.readableStreamClosed) {
        await state.readableStreamClosed.catch(() => {});
        state.readableStreamClosed = null;
      }
      if (state.port) {
        await state.port.close().catch(() => {});
        state.port = null;
      }
    } finally {
      state.mode = 'idle';
      state.isTiming = false;
      state.isVibrating = false;
      updateConnectionUI();
      renderPostureState();
      if (!silent) {
        appendLog('Disconnected from ESP32.', 'muted');
      }
    }
  }

  /* ------------------------------------------------------------------------
     Interactive Demo Mode (Mirrors ESP32 loop() at 100ms)
     ------------------------------------------------------------------------ */
  function startDemoMode() {
    if (state.mode === 'serial') {
      disconnectSerial(true);
    }

    state.mode = 'demo';
    resetSessionMetrics();
    state.simTick = 0;
    state.simBaseline = 2.0;
    state.simSmoothed = 2.0;
    state.simTargetRaw = 2.0;
    state.simIsTiming = false;
    state.simBadStart = 0;
    state.simIsVibrating = false;

    dom.simAngleSlider.value = '2';
    dom.simSliderVal.textContent = '2.0°';
    dom.demoControls.classList.remove('hidden');
    updateConnectionUI();

    // Emit startup serial message just like setup()
    handleSerialLine('MPU6050 connected successfully!');
    handleSerialLine('Posture Calibrated! New baseline saved.');

    state.demoTimer = setInterval(runDemoStep, 100);
  }

  function stopDemoMode() {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
    state.mode = 'idle';
    state.isTiming = false;
    state.isVibrating = false;
    dom.demoControls.classList.add('hidden');
    updateConnectionUI();
    renderPostureState();
    appendLog('Demo mode stopped.', 'muted');
  }

  function runDemoStep() {
    state.simTick += 1;

    // Auto-cycle realistically through upright -> gradual slouch -> 5s latch -> recovery
    if (dom.chkAutoSim.checked) {
      const phase = state.simTick % 210; // 21-second loop
      if (phase < 55) {
        // Upright sitting with natural breathing sway
        state.simTargetRaw = state.simBaseline + 1.5 + Math.sin(phase * 0.25) * 1.4;
      } else if (phase < 135) {
        // Leaning forward into a slouch (~14.5° deviation) for 8 seconds -> triggers motor at 5s
        state.simTargetRaw = state.simBaseline + 14.5 + Math.sin(phase * 0.18) * 1.1;
      } else if (phase < 165) {
        // Slowly sitting back up (still > 3° briefly, demonstrating hysteresis latch)
        const t = (phase - 135) / 30;
        state.simTargetRaw = state.simBaseline + 14.5 * (1 - t);
      } else {
        // Corrected upright posture (< 3°)
        state.simTargetRaw = state.simBaseline + 0.8 + Math.sin(phase * 0.2) * 0.9;
      }

      const clampedSlider = clamp(state.simTargetRaw, -10, 28);
      dom.simAngleSlider.value = clampedSlider.toFixed(1);
      dom.simSliderVal.textContent = `${clampedSlider.toFixed(1)}°`;
    }

    // Small realistic MPU6050 accelerometer noise
    const jitter = (Math.random() - 0.5) * 0.9;
    const rawAngle = state.simTargetRaw + jitter;

    // Exact ESP32 smoothing filter
    state.simSmoothed = 0.85 * state.simSmoothed + 0.15 * rawAngle;
    const deviation = state.simSmoothed - state.simBaseline;

    // Format the exact Serial line from ESP32
    const serialLine = `Baseline: ${state.simBaseline.toFixed(2)} | Current Angle: ${state.simSmoothed.toFixed(2)} | Signed Deviation: ${deviation.toFixed(2)}`;
    handleSerialLine(serialLine);

    // Exact ESP32 latching state for printing recovery message
    const now = Date.now();
    if (!state.simIsVibrating) {
      if (deviation > ANGLE_THRESHOLD) {
        if (!state.simIsTiming) {
          state.simBadStart = now;
          state.simIsTiming = true;
        } else if (now - state.simBadStart >= DURATION_THRESHOLD) {
          state.simIsVibrating = true;
        }
      } else {
        state.simIsTiming = false;
      }
    } else if (deviation < RECOVERY_THRESHOLD) {
      state.simIsVibrating = false;
      state.simIsTiming = false;
      handleSerialLine('Posture corrected! Vibration stopped.');
    }
  }

  function simulateCalibrationPress() {
    if (state.mode !== 'demo') return;
    state.simBaseline = state.simSmoothed;
    state.simIsTiming = false;
    state.simIsVibrating = false;
    handleSerialLine('Posture Calibrated! New baseline saved.');
  }

  /* ------------------------------------------------------------------------
     Session Management & CSV Export
     ------------------------------------------------------------------------ */
  function resetSessionMetrics() {
    state.sessionStart = Date.now();
    state.totalSamples = 0;
    state.goodSamples = 0;
    state.alertCount = 0;
    state.peakDeviation = 0;
    state.samples = [];
    state.csvRows = [];
    state.sampleTimestamps = [];
    state.isTiming = false;
    state.isVibrating = false;
    dom.btnExportCsv.disabled = true;
    renderStats();
    drawChart();
  }

  function exportCsv() {
    if (state.csvRows.length === 0) return;

    const header = [
      'timestamp_iso',
      'baseline_deg',
      'current_angle_deg',
      'signed_deviation_deg',
      'posture_state',
      'motor_gpio12',
    ];
    const lines = [header.join(','), ...state.csvRows.map((r) => r.join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `posture-session-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function updateConnectionUI() {
    if (state.mode === 'serial') {
      dom.connPill.dataset.state = 'connected';
      dom.connLabel.textContent = `ESP32 · ${BAUD_RATE}`;
      dom.btnConnect.textContent = 'Disconnect';
      dom.btnConnect.classList.add('is-connected');
      dom.btnDemo.textContent = 'Demo Mode';
      dom.btnDemo.classList.remove('is-active');
    } else if (state.mode === 'demo') {
      dom.connPill.dataset.state = 'demo';
      dom.connLabel.textContent = 'Demo Simulator';
      dom.btnConnect.textContent = 'Connect ESP32';
      dom.btnConnect.classList.remove('is-connected');
      dom.btnDemo.textContent = 'Stop Demo';
      dom.btnDemo.classList.add('is-active');
    } else {
      dom.connPill.dataset.state = 'disconnected';
      dom.connLabel.textContent = 'Not connected';
      dom.btnConnect.textContent = 'Connect ESP32';
      dom.btnConnect.classList.remove('is-connected');
      dom.btnDemo.textContent = 'Demo Mode';
      dom.btnDemo.classList.remove('is-active');
    }
  }

  /* ------------------------------------------------------------------------
     Event Bindings & Initialization
     ------------------------------------------------------------------------ */
  function init() {
    if (!('serial' in navigator)) {
      dom.serialWarning.classList.remove('hidden');
    }

    // Header actions
    dom.btnConnect.addEventListener('click', () => {
      if (state.mode === 'serial') {
        disconnectSerial();
      } else {
        connectSerial();
      }
    });

    dom.btnDemo.addEventListener('click', () => {
      if (state.mode === 'demo') {
        stopDemoMode();
      } else {
        startDemoMode();
      }
    });

    // Hardware modal
    const openModal = () => dom.hardwareModal.classList.remove('hidden');
    const closeModal = () => dom.hardwareModal.classList.add('hidden');
    dom.btnHardware.addEventListener('click', openModal);
    dom.btnCloseModal.addEventListener('click', closeModal);
    dom.hardwareModal.addEventListener('click', (e) => {
      if (e.target === dom.hardwareModal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.hardwareModal.classList.contains('hidden')) {
        closeModal();
      }
    });

    // Demo simulator controls
    dom.simAngleSlider.addEventListener('input', (e) => {
      dom.chkAutoSim.checked = false;
      const val = parseFloat(e.target.value);
      state.simTargetRaw = val;
      dom.simSliderVal.textContent = `${val.toFixed(1)}°`;
    });

    dom.btnSimCalibrate.addEventListener('click', simulateCalibrationPress);

    dom.btnSimSlouch.addEventListener('click', () => {
      dom.chkAutoSim.checked = false;
      const slouchAngle = clamp(state.simBaseline + 15, -10, 28);
      state.simTargetRaw = slouchAngle;
      dom.simAngleSlider.value = slouchAngle.toFixed(1);
      dom.simSliderVal.textContent = `${slouchAngle.toFixed(1)}°`;
    });

    // Chart controls
    dom.btnPauseChart.addEventListener('click', () => {
      state.chartPaused = !state.chartPaused;
      dom.btnPauseChart.textContent = state.chartPaused ? 'Resume' : 'Pause';
    });

    dom.btnClearChart.addEventListener('click', () => {
      state.samples = [];
      drawChart();
    });

    // Serial log clear
    dom.btnClearLog.addEventListener('click', () => {
      dom.serialOutput.innerHTML = '';
    });

    // CSV export
    dom.btnExportCsv.addEventListener('click', exportCsv);

    // Keep session duration ticking smoothly every second while active
    setInterval(() => {
      if (state.mode !== 'idle' && state.sessionStart) {
        dom.statTime.textContent = formatDuration(Date.now() - state.sessionStart);
      }
    }, 1000);

    // Responsive canvas resizing
    const resizeObserver = new ResizeObserver(resizeChartCanvas);
    resizeObserver.observe(dom.chartCanvas.parentElement);
    resizeChartCanvas();
    renderPostureState();
  }

  init();
})();
