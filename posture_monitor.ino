#include <Wire.h>
#include <MPU6050.h>

MPU6050 mpu;

const int MOTOR_PIN = 12;         // Haptic motor connected to GPIO 12
const int BUTTON_PIN = 4;         // Calibration button connected to GPIO 4 (other wire to GND)

const float ANGLE_THRESHOLD = 10.0;     // Slouch trigger threshold (10 degrees deviation)
const float RECOVERY_THRESHOLD = 3.0;   // Recovery threshold (must return below this to stop vibration)
const unsigned long DURATION_THRESHOLD = 5000; // 5 seconds continuous slouch duration

unsigned long badPostureStartTime = 0;
bool isTiming = false;
bool isVibrating = false;         // State tracker to keep vibration continuous
float baselineAngle = 0;          // Stores your calibrated upright angle
float smoothedAngle = 0;          // Filtered angle to eliminate body jitter/noise

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);             // SDA = GPIO 21, SCL = GPIO 22 for ESP32
  
  mpu.initialize();
  pinMode(MOTOR_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP); // Enable internal pull-up resistor for button
  digitalWrite(MOTOR_PIN, LOW);

  if (!mpu.testConnection()) {
    Serial.println("MPU6050 connection failed!");
  } else {
    Serial.println("MPU6050 connected successfully!");
  }
}

void loop() {
  // 1. Check if calibration button is pressed (LOW when pressed)
  if (digitalRead(BUTTON_PIN) == LOW) {
    baselineAngle = smoothedAngle; // Capture current posture as straight baseline
    isTiming = false;              
    isVibrating = false;           // Reset vibration state
    digitalWrite(MOTOR_PIN, LOW);  // Kill motor immediately on calibration
    
    Serial.println("Posture Calibrated! New baseline saved.");
    
    // Quick confirmation buzz
    digitalWrite(MOTOR_PIN, HIGH);
    delay(150);
    digitalWrite(MOTOR_PIN, LOW);
    delay(400); // Debounce delay
  }

  int16_t ax, ay, az, gx, gy, gz;
  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

  // Calculate tilt angle for vertical back mounting using 'ay'
  float rawAngle = atan2(ay, sqrt((float)ax * ax + (float)az * az)) * 180.0 / PI;

  // Apply smoothing filter
  smoothedAngle = (0.85 * smoothedAngle) + (0.15 * rawAngle);

  // Signed deviation tracking from baseline
  float postureDeviation = smoothedAngle - baselineAngle;

  Serial.print("Baseline: ");
  Serial.print(baselineAngle);
  Serial.print(" | Current Angle: ");
  Serial.print(smoothedAngle);
  Serial.print(" | Signed Deviation: ");
  Serial.println(postureDeviation);

  // 2. Posture Evaluation & Latching Logic
  if (!isVibrating) {
    // If not currently vibrating, check if we are slouching (> 10°)
    if (postureDeviation > ANGLE_THRESHOLD) {
      if (!isTiming) {
        badPostureStartTime = millis(); // Start the 5-second timer
        isTiming = true;
      } else {
        // Check if bad posture has lasted continuously for 5 seconds
        if (millis() - badPostureStartTime >= DURATION_THRESHOLD) {
          isVibrating = true; // Trigger continuous vibration state!
        }
      }
    } else {
      // If user corrects posture before 5 seconds, reset the timer
      isTiming = false;
    }
  } 
  else {
    // Once vibrating, keep it on UNTIL the user sits up straight (< 3°)
    if (postureDeviation < RECOVERY_THRESHOLD) {
      isVibrating = false; // Stop vibration
      isTiming = false;    // Reset timer
      Serial.println("Posture corrected! Vibration stopped.");
    }
  }

  // Set motor pin based on the continuous vibration state
  digitalWrite(MOTOR_PIN, isVibrating ? HIGH : LOW);

  delay(100);
}
