#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <ESP32Servo.h>

// Pin definitions for NodeMCU ESP32 WiFi/Bluetooth Dev Board
#define PH_PIN 35        // ADC1_CH7 - pH sensor analog input
#define SOIL_PIN 34      // ADC1_CH6 - soil moisture analog input  
#define DHT_PIN 27       // Digital pin - DHT22 data
#define SERVO_PIN 26     // PWM pin - servo control
#define DHT_TYPE DHT22

// WiFi credentials
const char* ssid = "Unifi";      // Replace with your WiFi name
const char* password = "99990000"; // Replace with your WiFi password

// HiveMQ Public MQTT Broker Configuration (No Authentication Required)
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

// MQTT Topics (Use unique topics to avoid conflicts with other users)
const char* sensor_topic = "plant_monitoring/sensors/unifi"; // Replace 'your_unique_id' with something unique
const char* servo_topic = "plant_monitoring/servo/unifi";   // Replace 'your_unique_id' with something unique
const char* status_topic = "plant_monitoring/status/unifi";  // Replace 'your_unique_id' with something unique

// Sensor variables
// pH Calibration (adjust based on your sensor)
const float pH_VOLTAGE_AT_7 = 2.70;  // Measure this in pH 7 buffer
const float pH_SLOPE = -5.70;        // Typical for many modules

float phValue = 0.0;
float soilMoisture = 0.0;
float temperature = 0.0;
float humidity = 0.0;
DHT dht(DHT_PIN, DHT_TYPE);
Servo servo;
WiFiClient espClient;
PubSubClient client(espClient);

// Servo control variables
int servoPosition = 0;  // 0 = closed, 180 = open
unsigned long lastServoCheck = 0;
const unsigned long SERVO_CHECK_INTERVAL = 5000; // Check every 5 seconds

void setup() {
  Serial.begin(115200);
  
  Serial.println("Initializing NodeMCU ESP32 System with HiveMQ...");
  
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
  
  // Configure MQTT client
  client.setServer(mqtt_server, mqtt_port);
  // client.setCallback(callback); // Uncomment if you want to receive MQTT messages
  
  Serial.println("NodeMCU ESP32 System Ready with HiveMQ!");
  Serial.println("pH: GPIO 35, Soil: GPIO 34, DHT22: GPIO 27, Servo: GPIO 26");
}

void loop() {
  static unsigned long lastReadTime = 0;
  const unsigned long READ_INTERVAL = 5000;  // Read every 2 seconds
  
  // Reconnect to MQTT if connection is lost
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();
  
  // Read sensors and send data every 2 seconds
  if (millis() - lastReadTime > READ_INTERVAL) {
    readSensors();
    sendToMQTT();
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
  // phValue = 7.0 + ((voltage - 2.5) * -3.5); // Simplified pH conversion
  // phValue = pH_SLOPE * voltage + (7.0 - pH_SLOPE * pH_VOLTAGE_AT_7);
  // phValue = -5.70 * voltage + 22.39;  // 2.7V = pH 7
  // phValue = -16.89 * voltage + 49.62;
  phValue = -4.98 * voltage + 20.45;  // Calibrated: 2.70V = pH 7, 3.30V = pH 4
  
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

void sendToMQTT() {
  if (client.connected()) {
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
    
    // Publish to MQTT topic
    bool publishResult = client.publish(sensor_topic, jsonString.c_str());
    
    if (publishResult) {
      Serial.println("✓ Data sent to HiveMQ: Success");
    } else {
      Serial.println("✗ Error sending data to HiveMQ");
    }
  } else {
    Serial.println("✗ MQTT not connected, skipping data send");
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
    
    // Also send servo position change via MQTT
    StaticJsonDocument<100> servoDoc;
    servoDoc["servo_position"] = servoPosition;
    servoDoc["timestamp"] = millis();
    
    String servoJson;
    serializeJson(servoDoc, servoJson);
    
    client.publish(servo_topic, servoJson.c_str());
  }
}

void reconnectMQTT() {
  // Loop until we're reconnected
  while (!client.connected()) {
    Serial.print("Attempting HiveMQ connection...");
    
    // Create a random client ID to avoid conflicts
    String clientId = "ESP32Client-";
    clientId += String(random(0xffff), HEX);
    
    // Attempt to connect (no username/password needed)
    if (client.connect(clientId.c_str())) {
      Serial.println(" ✓ HiveMQ connected");
      // Once connected, publish an announcement...
      client.publish(status_topic, "ESP32 NodeMCU connected");
      Serial.println("Client ID: " + clientId);
    } else {
      Serial.print(" ✗ failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      // Wait 5 seconds before retrying
      delay(5000);
    }
  }
}

// Uncomment and implement this function if you want to receive MQTT commands
/*
void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  for (int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println();
}
*/