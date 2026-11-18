# Posture Monitor — ESP32 & MPU6050

Real-time posture telemetry dashboard for an ESP32 + MPU6050 slouch detector with haptic feedback. Connects directly over USB via the browser's **Web Serial API** at `115200 baud`, with a built-in interactive **Demo Mode** for testing without hardware.

## Features

- **Direct USB Serial Connection** — Reads the exact output of `posture_monitor.ino` (`Baseline`, `Current Angle`, `Signed Deviation`, calibration, and recovery events) with no Wi-Fi setup needed.
- **Live Back-Tilt Visualizer** — Real-time spine angle indicator with `+10°` slouch trigger wedge, `+3°` recovery zone, and haptic motor vibration indicator.
- **Firmware-Synced State Machine** — Tracks the 5-second continuous slouch timer, latched vibration alert (`GPIO 12`), and `< 3°` recovery threshold.
- **Live 30-Second Deviation Chart** — High-DPI canvas strip chart with threshold lines, calibration markers, pause/clear controls, and CSV session export.
- **Built-in Serial Monitor & Demo Simulator** — View raw 115200-baud output or simulate slouch/calibration cycles directly in the browser.

## Hardware Pinout

| Component | ESP32 Pin | Notes |
| --- | --- | --- |
| MPU6050 SDA | `GPIO 21` | I²C data |
| MPU6050 SCL | `GPIO 22` | I²C clock |
| Haptic Motor | `GPIO 12` | Latches `HIGH` after 5s > `10°` |
| Calibrate Button | `GPIO 4` | `INPUT_PULLUP` (other wire to `GND`) |

## Usage

1. Upload `posture_monitor.ino` to your ESP32.
2. Close the Arduino IDE Serial Monitor (only one app can hold the COM port at a time).
3. Open the deployed Vercel site (or `http://localhost:8080`) in **Chrome** or **Edge**.
4. Click **Connect ESP32** and select your USB-to-Serial port.
