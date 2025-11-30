#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Servo.h>

// Pin definitions for NodeMCU ESP32 WiFi/Bluetooth Dev Board
#define PH_PIN 35        // ADC1_CH7 - pH sensor analog input
#define SOIL_PIN 34      // ADC1_CH6 - soil moisture analog input  
#define DHT_PIN 27       // Digital pin - DHT22 data
#define SERVO_PIN 26     // PWM pin - servo control
#define DHT_TYPE DHT22

// WiFi credentials
const char* ssid = "Unifi";      // Replace with your WiFi name
const char* password = "99990000"; // Replace with your WiFi password

// Database server (your laptop's IP)
const char* serverName = "192.168.1.100"; // Replace with your laptop's IP
const int serverPort = 3000;

// Sensor variables
float phValue = 0.0;
float soilMoisture = 0.0;
float temperature = 0.0;
float humidity = 0.0;
DHT dht(DHT_PIN, DHT_TYPE);
Servo servo;

// Servo control variables
int servoPosition = 0;  // 0 = closed, 180 = open
unsigned long lastServoCheck = 0;
const unsigned long SERVO_CHECK_INTERVAL = 5000; // Check every 5 seconds

void setup() {
  Serial.begin(115200);
  
  Serial.println("Initializing NodeMCU ESP32 System...");
  
  // Initialize pins and sensors
  pinMode(PH_PIN, INPUT);
  pinMode(SOIL_PIN, INPUT);
  dht.begin();
  
  // Initialize servo
  servo.attach(SERVO_PIN);
  servo.write(0); // Start with servo closed
  Serial.println("Servo initialized at 0°");
  
  // Connect to WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("WiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  
  Serial.println("NodeMCU ESP32 System Ready!");
  Serial.println("pH: GPIO 35, Soil: GPIO 34, DHT22: GPIO 27, Servo: GPIO 26");
}

void loop() {
  static unsigned long lastReadTime = 0;
  const unsigned long READ_INTERVAL = 2000;  // Read every 2 seconds
  
  // Read sensors and send data every 2 seconds
  if (millis() - lastReadTime > READ_INTERVAL) {
    readSensors();
    sendToDatabase();
    lastReadTime = millis();
  }
  
  // Check servo control every 5 seconds using fuzzy logic
  if (millis() - lastServoCheck > SERVO_CHECK_INTERVAL) {
    controlServoWithFuzzyLogic();
    lastServoCheck = millis();
  }
  
  delay(100);
}

void readSensors() {
  // Read pH sensor (NodeMCU GPIO 35)
  int rawADC = analogRead(PH_PIN);
  float voltage = rawADC * 3.3 / 4095.0;
  phValue = 7.0 + ((voltage - 2.5) * -3.5); // Simplified pH conversion
  
  // Read soil moisture sensor (NodeMCU GPIO 34)
  int soilRaw = analogRead(SOIL_PIN);
  soilMoisture = map(soilRaw, 4095, 1500, 0, 100); // Calibrate based on your sensor
  soilMoisture = constrain(soilMoisture, 0, 100);
  
  // Read DHT22 sensor (NodeMCU GPIO 27)
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();
  
  if (!isnan(temp) && !isnan(hum)) {
    temperature = temp;
    humidity = hum;
  }
  
  // Display current readings
  Serial.printf("NodeMCU Sensors - pH: %.2f, Soil: %.1f%%, Temp: %.1f°C, Humidity: %.1f%%, Servo: %d°\n", 
                phValue, soilMoisture, temperature, humidity, servoPosition);
}

void sendToDatabase() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    String serverPath = "http://" + String(serverName) + ":" + String(serverPort) + "/api/sensors";
    
    http.begin(serverPath);
    http.addHeader("Content-Type", "application/json");
    
    // Create JSON payload with NodeMCU sensor data
    StaticJsonDocument<250> doc;
    doc["ph"] = phValue;
    doc["soil"] = soilMoisture;
    doc["temperature"] = temperature;
    doc["humidity"] = humidity;
    doc["servo_position"] = servoPosition;
    doc["timestamp"] = millis();
    doc["board_type"] = "NodeMCU_ESP32";
    
    String jsonString;
    serializeJson(doc, jsonString);
    
    int httpResponseCode = http.POST(jsonString);
    
    if (httpResponseCode > 0) {
      Serial.println("✓ Data sent to database: Success");
    } else {
      Serial.print("✗ Error sending data, code: ");
      Serial.println(httpResponseCode);
    }
    
    http.end();
  } else {
    Serial.println("✗ WiFi not connected, skipping data send");
  }
}

// Fuzzy Logic Control Function for NodeMCU
void controlServoWithFuzzyLogic() {
  // pH range: 4.4 to 5.5 (target range)
  // Soil moisture range: 0-100%
  
  int newServoPos = 0; // Default closed
  
  // Fuzzy Logic Rules for NodeMCU ESP32:
  // Rule 1: If pH is too low (below 4.4) OR soil is too dry (below 30%), open valve
  if (phValue < 4.4 || soilMoisture < 30) {
    newServoPos = 180; // Open valve - add base/water
    Serial.println("🔍 Fuzzy Logic: pH too low OR soil too dry -> Servo OPEN (180°)");
  }
  // Rule 2: If pH is too high (above 5.5) OR soil is too wet (above 70%), close valve
  else if (phValue > 5.5 || soilMoisture > 70) {
    newServoPos = 0; // Close valve
    Serial.println("🔍 Fuzzy Logic: pH too high OR soil too wet -> Servo CLOSED (0°)");
  }
  // Rule 3: If pH is in target range AND soil is in good range, adjust partially
  else if (phValue >= 4.4 && phValue <= 5.5) {
    // Calculate proportional opening based on soil moisture
    if (soilMoisture < 40) {
      newServoPos = 90; // Half open
      Serial.println("🔍 Fuzzy Logic: Optimal pH, dry soil -> Servo HALF OPEN (90°)");
    } else if (soilMoisture < 50) {
      newServoPos = 45; // Quarter open
      Serial.println("🔍 Fuzzy Logic: Optimal pH, moderate soil -> Servo QUARTER OPEN (45°)");
    } else {
      newServoPos = 0; // Mostly closed
      Serial.println("🔍 Fuzzy Logic: Optimal pH, good soil -> Servo CLOSED (0°)");
    }
  }
  
  // Smooth servo movement to avoid sudden changes
  if (abs(newServoPos - servoPosition) > 10) {
    servoPosition = newServoPos;
    servo.write(servoPosition);
    Serial.printf("⚙️ Servo moved to: %d° (pH: %.2f, Soil: %.1f%%)\n", servoPosition, phValue, soilMoisture);
  }
}