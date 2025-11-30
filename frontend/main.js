require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = 3000;
const useDummyData = process.env.USE_DUMMY_DATA === 'true';

app.use(cors());
app.use(express.json());

// MongoDB setup
// Uses Atlas connection string; override with MONGODB_URI env var if needed
const uri = process.env.MONGODB_URI || "mongodb+srv://aryahuda52_db_user:unifi909090@cluster0.8eijhui.mongodb.net/?appName=Cluster0";
const dbName = process.env.MONGODB_DB || "sensorDB";


// MQTT Configuration
const mqttBroker = 'mqtt://broker.hivemq.com';
const topics = [
  'plant_monitoring/sensors/unifi',
  'plant_monitoring/servo/unifi',
  'plant_monitoring/status/unifi'
];

// MongoDB client
let db;
let mongoClient;
let inMemorySensors = [];

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeLimit(rawLimit, fallback = 500) {
  const parsed = parseInt(rawLimit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 5000); // guard against accidental huge exports
}

async function getSensorRange({ start, end, limit = 500, sortDirection = -1 }) {
  const query = {};
  if (start || end) {
    query.receivedAt = {};
    if (start) query.receivedAt.$gte = start;
    if (end) query.receivedAt.$lte = end;
  }

  if (useDummyData) {
    let readings = [...inMemorySensors];
    if (query.receivedAt) {
      readings = readings.filter((reading) => {
        const ts = new Date(reading.receivedAt).getTime();
        const afterStart = query.receivedAt.$gte ? ts >= query.receivedAt.$gte.getTime() : true;
        const beforeEnd = query.receivedAt.$lte ? ts <= query.receivedAt.$lte.getTime() : true;
        return afterStart && beforeEnd;
      });
    }
    readings.sort((a, b) => (sortDirection === 1
      ? new Date(a.receivedAt) - new Date(b.receivedAt)
      : new Date(b.receivedAt) - new Date(a.receivedAt)));
    return readings.slice(0, limit);
  }

  return db.collection('sensors')
    .find(query)
    .sort({ receivedAt: sortDirection })
    .limit(limit)
    .toArray();
}

function escapeCsvValue(value) {
  if (value === undefined || value === null) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function connectMQTT() {
  const client = mqtt.connect(mqttBroker, {
    clientId: 'mqtt_to_mongodb_' + Math.random().toString(16).substr(2, 8),
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 1000,
  });

  client.on('connect', () => {
    console.log('Connected to HiveMQ broker');
    client.subscribe(topics, (err) => {
      if (err) {
        console.error('MQTT subscription error:', err);
      } else {
        console.log('Subscribed to topics:', topics);
      }
    });
  });

  client.on('message', async (topic, message) => {
    try {
      console.log(`Message received on topic: ${topic}`);
      console.log('Message payload:', message.toString());
      
      // Parse the JSON message
      const sensorData = JSON.parse(message.toString());
      sensorData.receivedAt = new Date();
      sensorData.topic = topic; // Store the topic for reference
      
      // Determine collection based on topic
      let collectionName = 'sensors';
      if (topic.includes('servo')) {
        collectionName = 'servo';
      } else if (topic.includes('status')) {
        collectionName = 'status';
      }
      
      // Insert into MongoDB or in-memory list
      if (useDummyData) {
        inMemorySensors.push(sensorData);
      } else if (db) {
        await db.collection(collectionName).insertOne(sensorData);
      } else {
        console.error('Database not initialized; dropping message');
        return;
      }
      console.log(`Data saved to ${collectionName}`);
      
    } catch (error) {
      console.error('Error processing message:', error.message);
    }
  });

  client.on('error', (error) => {
    console.error('MQTT error:', error);
  });

  client.on('reconnect', () => {
    console.log('Reconnecting to MQTT broker...');
  });

  client.on('close', () => {
    console.log('MQTT connection closed');
  });
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (mongoClient) {
    await mongoClient.close();
    console.log('MongoDB connection closed');
  }
  process.exit(0);
});

function seedDummyData() {
  const now = new Date();
  inMemorySensors = [
    {
      ph: 5.0,
      soil: 55,
      temperature: 26.4,
      humidity: 62.3,
      servo_position: 90,
      receivedAt: now,
    },
    {
      ph: 4.7,
      soil: 35,
      temperature: 27.1,
      humidity: 58.2,
      servo_position: 120,
      receivedAt: new Date(now.getTime() - 60_000),
    },
  ];
}

async function connectDB() {
  if (useDummyData) {
    if (inMemorySensors.length === 0) {
      seedDummyData();
    }
    console.log('Using in-memory dummy data; MongoDB connection skipped.');
    return;
  }
  if (db) {
    return;
  }
  mongoClient = new MongoClient(uri, {
    // These are the ONLY recommended options for Atlas
    serverSelectionTimeoutMS: 5000,
    // heartbeatFrequencyMS: 10000, // optional
    // socketTimeoutMS: 45000,     // optional
    });
  await mongoClient.connect();
  db = mongoClient.db(dbName);
  console.log(`Connected to MongoDB: ${dbName}`);
  // Ensure collection exists; ignore if already created
  await Promise.all([
    db.createCollection('sensors').catch(() => {}),
    db.createCollection('servo').catch(() => {}),
    db.createCollection('status').catch(() => {}),
  ]);
}

// Endpoint to receive sensor data from ESP32
app.post('/api/sensors', async (req, res) => {
  try {
    const sensorData = req.body;
    sensorData.receivedAt = new Date();
    
    if (useDummyData) {
      inMemorySensors.push(sensorData);
    } else {
      await db.collection('sensors').insertOne(sensorData);
    }
    res.status(200).json({ success: true, message: 'Data saved to database' });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to get sensor data within a date range (defaults to latest)
app.get('/api/sensors/range', async (req, res) => {
  try {
    const start = normalizeDate(req.query.start);
    const end = normalizeDate(req.query.end);
    const limit = normalizeLimit(req.query.limit, 200);

    if (req.query.start && !start) {
      return res.status(400).json({ error: 'Invalid start date' });
    }
    if (req.query.end && !end) {
      return res.status(400).json({ error: 'Invalid end date' });
    }

    const data = await getSensorRange({ start, end, limit, sortDirection: -1 });
    return res.json({ data, count: data.length });
  } catch (error) {
    console.error('Error fetching range data:', error);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Endpoint to download sensor data as CSV with optional date range
app.get('/api/sensors/csv', async (req, res) => {
  try {
    const start = normalizeDate(req.query.start);
    const end = normalizeDate(req.query.end);
    const limit = normalizeLimit(req.query.limit, 1000);

    if (req.query.start && !start) {
      return res.status(400).json({ error: 'Invalid start date' });
    }
    if (req.query.end && !end) {
      return res.status(400).json({ error: 'Invalid end date' });
    }

    const headers = ['ph', 'soil', 'temperature', 'humidity', 'servo_position', 'topic', 'receivedAt'];
    const data = await getSensorRange({ start, end, limit, sortDirection: 1 });
    const csvRows = [
      headers.join(','),
      ...data.map((row) => headers.map((field) => escapeCsvValue(row[field])).join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sensor-data.csv"');
    return res.send(csvRows.join('\n'));
  } catch (error) {
    console.error('Error generating CSV:', error);
    return res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// Endpoint to get latest sensor data
app.get('/api/sensors/latest', async (req, res) => {
  try {
    let latest;
    if (useDummyData) {
      latest = inMemorySensors[inMemorySensors.length - 1];
    } else {
      latest = await db.collection('sensors').findOne(
        {}, 
        { sort: { receivedAt: -1 } }
      );
    }
    res.json(latest || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple web interface to view data and control
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Sensor Dashboard with Fuzzy Control</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .sensor-card { 
                border: 1px solid #ccc; 
                padding: 15px; 
                margin: 10px; 
                border-radius: 5px;
                display: inline-block;
                width: 180px;
                text-align: center;
                background: #f9f9f9;
            }
            .control-card {
                border: 2px solid #4CAF50;
                padding: 15px;
                margin: 10px;
                border-radius: 5px;
                display: inline-block;
                width: 200px;
                text-align: center;
                background: #e8f5e8;
            }
            h1 { color: #333; }
            .status-ok { color: green; }
            .status-warning { color: orange; }
            .status-critical { color: red; }
            .history-card {
                border: 1px solid #ddd;
                padding: 15px;
                margin-top: 20px;
                border-radius: 6px;
                background: #fff;
                max-width: 740px;
            }
            .range-row {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                align-items: flex-end;
            }
            .range-row label {
                font-size: 12px;
                color: #555;
            }
            .range-row input {
                padding: 6px;
                border: 1px solid #ccc;
                border-radius: 4px;
            }
            .range-actions button {
                margin-right: 8px;
                padding: 8px 12px;
                border: none;
                border-radius: 4px;
                background: #4CAF50;
                color: white;
                cursor: pointer;
            }
            .range-actions button:hover {
                opacity: 0.9;
            }
            .preview-list {
                margin-top: 10px;
            }
            .preview-item {
                border-bottom: 1px solid #eee;
                padding: 6px 0;
                font-size: 13px;
            }
            .preview-item:last-child {
                border-bottom: none;
            }
        </style>
    </head>
    <body>
        <h1>Smart Irrigation Dashboard</h1>
        
        <div id="sensors">
            <div class="sensor-card">
                <h3>pH Level</h3>
                <p id="ph-value" class="status-ok">--</p>
                <p id="ph-status">Optimal</p>
            </div>
            <div class="sensor-card">
                <h3>Soil Moisture</h3>
                <p id="soil-value" class="status-ok">--%</p>
                <p id="soil-status">Good</p>
            </div>
            <div class="sensor-card">
                <h3>Temperature</h3>
                <p id="temp-value">--&deg;C</p>
            </div>
            <div class="sensor-card">
                <h3>Humidity</h3>
                <p id="humidity-value">--%</p>
            </div>
        </div>
        
        <div id="controls">
            <div class="control-card">
                <h3>Servo Control</h3>
                <p id="servo-value">-- deg</p>
                <p id="servo-status">Auto Controlled</p>
            </div>
        </div>
        
        <div style="margin-top: 20px;">
            <h3>Fuzzy Logic Rules:</h3>
            <ul>
                <li>Low pH (< 4.4) OR Dry soil (< 30%) -> Valve OPEN (180 deg)</li>
                <li>High pH (> 5.5) OR Wet soil (> 70%) -> Valve CLOSED (0 deg)</li>
                <li>Target pH (4.4-5.5) + Good moisture (30-70%) -> Adjust as needed</li>
            </ul>
        </div>

        <div class="history-card">
            <h3>Data Range &amp; CSV Export</h3>
            <div class="range-row">
                <div>
                    <label for="start-date">Start</label><br>
                    <input type="datetime-local" id="start-date">
                </div>
                <div>
                    <label for="end-date">End</label><br>
                    <input type="datetime-local" id="end-date">
                </div>
                <div class="range-actions">
                    <button id="apply-range" type="button">Apply Range</button>
                    <button id="reset-range" type="button" style="background:#757575;">Reset</button>
                    <button id="download-csv" type="button" style="background:#008CBA;">Download CSV</button>
                </div>
            </div>
            <p id="range-status" style="margin-top: 10px;">No range applied yet.</p>
            <div id="range-preview" class="preview-list"></div>
        </div>

        <script>
            async function updateData() {
                try {
                    const response = await fetch('/api/sensors/latest');
                    const data = await response.json();
                    
                    if (data) {
                        // Update pH display with color coding
                        const phValue = document.getElementById('ph-value');
                        const phStatus = document.getElementById('ph-status');
                        if (data.ph) {
                            phValue.textContent = data.ph.toFixed(2);
                            if (data.ph < 4.4) {
                                phValue.className = 'status-critical';
                                phStatus.textContent = 'Too Low';
                            } else if (data.ph > 5.5) {
                                phValue.className = 'status-warning';
                                phStatus.textContent = 'Too High';
                            } else {
                                phValue.className = 'status-ok';
                                phStatus.textContent = 'Optimal';
                            }
                        }
                        
                        // Update soil moisture display
                        const soilValue = document.getElementById('soil-value');
                        const soilStatus = document.getElementById('soil-status');
                        if (data.soil) {
                            soilValue.textContent = data.soil.toFixed(1) + '%';
                            if (data.soil < 30) {
                                soilValue.className = 'status-critical';
                                soilStatus.textContent = 'Too Dry';
                            } else if (data.soil > 70) {
                                soilValue.className = 'status-warning';
                                soilStatus.textContent = 'Too Wet';
                            } else {
                                soilValue.className = 'status-ok';
                                soilStatus.textContent = 'Good';
                            }
                        }
                        
                        // Update other sensors
                        if (data.temperature) {
                            document.getElementById('temp-value').textContent = data.temperature.toFixed(1) + ' C';
                        }
                        if (data.humidity) {
                            document.getElementById('humidity-value').textContent = data.humidity.toFixed(1) + '%';
                        }
                        if (data.servo_position !== undefined) {
                            document.getElementById('servo-value').textContent = data.servo_position + ' deg';
                        }
                    }
                } catch (error) {
                    console.error('Error fetching data:', error);
                }
            }

            // Range helpers for CSV export and quick previews
            const startInput = document.getElementById('start-date');
            const endInput = document.getElementById('end-date');
            const rangeStatus = document.getElementById('range-status');
            const rangePreview = document.getElementById('range-preview');

            function formatTimestamp(ts) {
                const date = new Date(ts);
                return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString();
            }

            function renderPreview(records) {
                if (!records.length) {
                    rangePreview.innerHTML = '<div class="preview-item">No data to preview.</div>';
                    return;
                }
                const html = records.slice(0, 5).map((item) => {
                    const ph = item.ph ?? '--';
                    const soil = item.soil ?? '--';
                    const temp = item.temperature ?? '--';
                    const humidity = item.humidity ?? '--';
                    return '<div class="preview-item">' +
                        '<strong>' + formatTimestamp(item.receivedAt) + '</strong> ' +
                        '- pH: ' + ph + ' | Soil: ' + soil + '% | Temp: ' + temp + ' C | Humidity: ' + humidity + '%' +
                        '</div>';
                }).join('');
                rangePreview.innerHTML = html;
            }

            function buildRangeQuery(limit) {
                const params = new URLSearchParams();
                if (startInput.value) {
                    params.set('start', new Date(startInput.value).toISOString());
                }
                if (endInput.value) {
                    params.set('end', new Date(endInput.value).toISOString());
                }
                if (limit) {
                    params.set('limit', String(limit));
                }
                return params.toString();
            }

            async function fetchRangeData() {
                try {
                    const query = buildRangeQuery(200);
                    const response = await fetch('/api/sensors/range' + (query ? ('?' + query) : ''));
                    const payload = await response.json();
                    if (!response.ok) {
                        throw new Error(payload.error || 'Server error');
                    }
                    const records = payload.data || [];
                    const hasRange = Boolean(startInput.value || endInput.value);
                    rangeStatus.textContent = records.length
                        ? ('Showing ' + records.length + ' reading(s)' + (hasRange ? ' for selected range' : ' (latest)') + '.')
                        : 'No data for selected range.';
                    renderPreview(records);
                } catch (error) {
                    console.error('Error fetching range data:', error);
                    rangeStatus.textContent = 'Failed to load range data.';
                    renderPreview([]);
                }
            }

            document.getElementById('apply-range').addEventListener('click', fetchRangeData);
            document.getElementById('reset-range').addEventListener('click', () => {
                startInput.value = '';
                endInput.value = '';
                fetchRangeData();
            });
            document.getElementById('download-csv').addEventListener('click', () => {
                const query = buildRangeQuery(1000);
                const url = '/api/sensors/csv' + (query ? ('?' + query) : '');
                window.location.href = url;
            });

            // Update every 2 seconds
            setInterval(updateData, 2000);
            updateData(); // Initial load
            fetchRangeData(); // Load initial preview
        </script>
    </body>
    </html>
  `);
});

async function startServer() {
  await connectDB();
  connectMQTT();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Access from other devices: http://YOUR_LAPTOP_IP:${PORT}`);
  });
}

startServer();
