/**
 * js/main.js
 * Master Client Controller for SmartPark Campus (Phase 2 Refactored).
 * Features:
 * - 100% Professional English UI & feedback
 * - Interactive 2D Smart Twin (Click bays to park, inspect, or check-out / release)
 * - Custom Vehicle Entry Simulator with random plate generator
 * - Preset Scenarios for instant edge-case testing
 * - Inline Guest Destination Selection
 * - Real image upload with automatic OCR preview and plate sync
 * - 3-second polling loop for Live FastAPI backend (:8000)
 */

// Global State
let USE_MOCK = true;
let currentScenarioKey = 'normal';
let activeSimulationTab = 'custom'; // 'custom' or 'presets'
let pollingTimer = null;
let currentPendingVehicle = null;

// Built-in Scenarios (Fallback & Instant Demo)
const MOCK_SCENARIOS = {
  normal: {
    name: '1. Normal (Ample bays available across all zones)',
    gate: { status: 'ok', plate: '51A12345', type: 'resident', building: 'A', confidence: 0.94 },
    occupied: ['A-01', 'A-04', 'B-02', 'B-05', 'C-01', 'C-03', 'D-02', 'D-04', 'G-01', 'G-03']
  },
  zone_a_full: {
    name: '2. Building A 100% Full (Auto overflow re-routing)',
    gate: { status: 'ok', plate: '51A99999', type: 'resident', building: 'A', confidence: 0.92 },
    occupied: ['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'B-03', 'C-01', 'D-02', 'G-01']
  },
  guest_zone_full: {
    name: '3. Guest Zone G 100% Full (Allocate nearest building)',
    gate: { status: 'ok', plate: '29A98246', type: 'guest', building: null, confidence: 0.89 },
    occupied: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'A-02', 'B-03', 'C-04']
  },
  lot_full: {
    name: '4. 🚨 Entire Campus 100% Full (Access Denied)',
    gate: { status: 'ok', plate: '30E88888', type: 'guest', building: null, confidence: 0.96 },
    all_occupied: true
  },
  only_one_slot: {
    name: '5. Single Bay Remaining Across Campus (D-06)',
    gate: { status: 'ok', plate: '43A67890', type: 'resident', building: 'B', confidence: 0.91 },
    all_occupied_except: ['D-06']
  },
  resident_building_b: {
    name: '6. Resident of Building B (51B56789)',
    gate: { status: 'ok', plate: '51B56789', type: 'resident', building: 'B', confidence: 0.95 },
    occupied: ['B-01', 'B-03', 'A-01', 'C-02', 'D-01']
  },
  ocr_unreadable: {
    name: '7. OCR Error: Unreadable Plate',
    gate: { status: 'error', code: 'PLATE_UNREADABLE', message: 'Unable to recognize license plate. Please scan again.' }
  },
  ocr_no_vehicle: {
    name: '8. OCR Error: No Vehicle Detected',
    gate: { status: 'error', code: 'NO_VEHICLE', message: 'No vehicle detected before barrier.' }
  }
};

// DOM References
const modeToggle = document.getElementById('modeToggle');
const serverStatusDot = document.getElementById('serverStatusDot');
const serverStatusText = document.getElementById('serverStatusText');
const scenarioSelect = document.getElementById('scenarioSelect');
const alertContainer = document.getElementById('alertContainer');
const capacityBadge = document.getElementById('capacityBadge');

const cameraFeed = document.getElementById('cameraFeed');
const cameraPreviewImg = document.getElementById('cameraPreviewImg');
const ocrPlateDisplay = document.getElementById('ocrPlateDisplay');
const ocrStatusBadge = document.getElementById('ocrStatusBadge');
const ocrVehicleType = document.getElementById('ocrVehicleType');
const ocrSlotDisplay = document.getElementById('ocrSlotDisplay');
const routeInfoDisplay = document.getElementById('routeInfoDisplay');
const elevatorInfoDisplay = document.getElementById('elevatorInfoDisplay');

const simulateEntryBtn = document.getElementById('simulateEntryBtn');
const clearRouteBtn = document.getElementById('clearRouteBtn');
const freeAllBaysBtn = document.getElementById('freeAllBaysBtn');
const imageUploadInput = document.getElementById('imageUploadInput');
const mapUploadInput = document.getElementById('mapUploadInput');

// Custom Vehicle Entry Simulator References
const tabCustomEntry = document.getElementById('tabCustomEntry');
const tabPresets = document.getElementById('tabPresets');
const customEntrySection = document.getElementById('customEntrySection');
const presetsSection = document.getElementById('presetsSection');
const customPlateInput = document.getElementById('customPlateInput');
const randomPlateBtn = document.getElementById('randomPlateBtn');
const customVehicleTypeSelect = document.getElementById('customVehicleTypeSelect');

// Inline Guest Destination Selector References
const guestDestinationCard = document.getElementById('guestDestinationCard');
const cancelGuestBtn = document.getElementById('cancelGuestBtn');

// Live Gate Activity Log References
const activityLogTbody = document.getElementById('activityLogTbody');
const recentActivityLogs = [];

/**
 * Appends a real-time event to the Live Activity Audit Log table.
 */
function logActivity(event, plate, bay, detail, statusClass = 'entry') {
  if (!activityLogTbody) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  recentActivityLogs.unshift({
    time: timeStr,
    event,
    plate,
    bay,
    detail,
    statusClass
  });

  if (recentActivityLogs.length > 7) {
    recentActivityLogs.pop();
  }

  activityLogTbody.innerHTML = recentActivityLogs.map((item) => `
    <tr>
      <td style="color: var(--text-muted); font-family: var(--font-mono);">${item.time}</td>
      <td style="font-weight: 700; font-family: var(--font-mono); color: #f8fafc;">${item.plate}</td>
      <td style="color: var(--text-muted);">${item.detail}</td>
      <td><strong style="color: #38bdf8;">${item.bay}</strong></td>
      <td><span class="activity-badge ${item.statusClass}">${item.event}</span></td>
    </tr>
  `).join('');
}

/**
 * Generates a realistic license plate format for testing.
 */
function generateRandomPlate() {
  const prefixes = ['51A', '51B', '51K', '29A', '29E', '30F', '43A', '60B', '72A'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${number}`;
}

/**
 * 1. CAPACITY & OCCUPANCY UI UPDATE
 */
function updateCapacityUI() {
  if (!window.parkingCanvas) return;
  const stats = window.parkingCanvas.getParkingStats();
  if (capacityBadge) {
    capacityBadge.innerHTML = `<span>🅿️</span> Available: ${stats.free}/${stats.total} Bays`;
    if (stats.free === 0) {
      capacityBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      capacityBadge.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      capacityBadge.style.color = '#f87171';
    } else {
      capacityBadge.style.background = 'rgba(34, 197, 94, 0.15)';
      capacityBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
      capacityBadge.style.color = '#86efac';
    }
  }
}

/**
 * 2. ALERT BANNER SYSTEM
 */
function showAlert(message, type = 'error') {
  if (!alertContainer) return;
  alertContainer.style.display = 'flex';
  alertContainer.className = `lot-alert-banner ${type}`;
  const icon = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '🚨';
  alertContainer.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
}

function clearAlert() {
  if (!alertContainer) return;
  alertContainer.style.display = 'none';
  alertContainer.innerHTML = '';
}

/**
 * 3. INLINE GUEST CARD DISPLAY TOGGLES
 */
function showGuestCard() {
  if (guestDestinationCard) {
    guestDestinationCard.classList.remove('hidden');
    guestDestinationCard.classList.add('show');
  }
}

function hideGuestCard() {
  if (guestDestinationCard) {
    guestDestinationCard.classList.remove('show');
    guestDestinationCard.classList.add('hidden');
  }
}

/**
 * 4. SCENARIO PRESET LOADER
 * Populates 30 slots state based on selected test preset.
 */
function applyScenario(scenarioKey) {
  currentScenarioKey = scenarioKey;
  clearAlert();
  hideGuestCard();

  const scenario = MOCK_SCENARIOS[scenarioKey];
  if (!scenario || !window.parkingCanvas) return;

  const allSlots = window.parkingCanvas.getActiveSlots();

  if (scenario.all_occupied) {
    // 100% Full Campus
    allSlots.forEach((s) => {
      s.occupied = true;
      s.isReserved = false;
    });
  } else if (scenario.all_occupied_except) {
    // Exactly 1 bay remaining
    allSlots.forEach((s) => {
      s.occupied = !scenario.all_occupied_except.includes(s.id);
      s.isReserved = false;
    });
  } else if (scenario.occupied || scenario.occupied_slots) {
    // Standard occupied array
    const occupiedList = scenario.occupied || scenario.occupied_slots || [];
    allSlots.forEach((s) => {
      s.occupied = occupiedList.includes(s.id);
      s.isReserved = false;
    });
  }

  window.parkingCanvas.initParkingMap();
  updateCapacityUI();

  // Reset route and preview values
  if (cameraPreviewImg) cameraPreviewImg.style.display = 'none';
  if (ocrPlateDisplay) {
    ocrPlateDisplay.textContent = '--';
    ocrPlateDisplay.classList.remove('error');
  }
  if (ocrStatusBadge) {
    ocrStatusBadge.textContent = 'Awaiting Vehicle';
    ocrStatusBadge.className = 'badge badge-guest';
    ocrStatusBadge.style.background = '';
    ocrStatusBadge.style.color = '';
  }
  if (ocrVehicleType) ocrVehicleType.textContent = '--';
  if (ocrSlotDisplay) ocrSlotDisplay.textContent = '--';
  if (routeInfoDisplay) routeInfoDisplay.textContent = 'Awaiting vehicle scan';
  if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';
}

/**
 * 5. GATE OCR HANDLER (Supports Custom Vehicle Input, Real API & Mock Presets)
 *
 * @param {File|null} uploadedImageFile
 */
async function triggerGateScan(uploadedImageFile = null) {
  clearAlert();
  hideGuestCard();
  console.log(`[GateVision] Scanning vehicle... Mode: ${USE_MOCK ? 'MOCK' : 'LIVE API'}, Tab: ${activeSimulationTab}`);

  let gateResponse = null;

  if (USE_MOCK) {
    if (activeSimulationTab === 'custom') {
      // DYNAMIC CUSTOM VEHICLE ENTRY
      const inputPlate = (customPlateInput && customPlateInput.value.trim()) ? customPlateInput.value.trim().toUpperCase() : generateRandomPlate();
      const selectedType = customVehicleTypeSelect ? customVehicleTypeSelect.value : 'resident_A';

      if (selectedType.startsWith('resident_')) {
        const building = selectedType.replace('resident_', '');
        gateResponse = {
          status: 'ok',
          plate: inputPlate,
          type: 'resident',
          building: building,
          confidence: 0.96
        };
      } else {
        gateResponse = {
          status: 'ok',
          plate: inputPlate,
          type: 'guest',
          building: null,
          confidence: 0.92
        };
      }
    } else {
      // PRESET SCENARIO
      const scenario = MOCK_SCENARIOS[currentScenarioKey] || MOCK_SCENARIOS.normal;
      gateResponse = scenario.gate;
    }
  } else {
    // ── Live FastAPI Backend Call ─────────────────────────────────────────────
    // Two endpoints (match backend/app.py):
    //   POST /api/gate/scan         → multipart image upload → AI pipeline
    //   POST /api/gate/scan/plate   → JSON plate string      → DB lookup only
    try {
      let apiData;

      if (uploadedImageFile) {
        // ── Path A: Real image → full YOLO+OCR+DB pipeline ──────────────────
        const formData = new FormData();
        formData.append('file', uploadedImageFile); // Backend expects field: 'file'

        const res = await fetch('http://localhost:8000/api/gate/scan', {
          method: 'POST',
          body: formData
        });
        if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
        apiData = await res.json();
      } else {
        // ── Path B: Manual plate text → DB lookup only (no OCR needed) ───────
        const manualPlate = (customPlateInput && customPlateInput.value.trim())
          ? customPlateInput.value.trim().toUpperCase()
          : '';

        if (!manualPlate) {
          // Nothing to send: fallback to random mock for demo
          gateResponse = { status: 'ok', plate: generateRandomPlate(), type: 'guest', building: null, confidence: 0.80 };
          handleGateResult(gateResponse);
          return;
        }

        const res = await fetch('http://localhost:8000/api/gate/scan/plate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plate: manualPlate })
        });
        if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
        apiData = await res.json();
      }

      // ── Normalize API response → internal gate schema ─────────────────────
      // Backend returns: { license_plate, confidence, is_resident, resident_name, building, error }
      // Internal schema: { status, plate, type, building, confidence }
      if (apiData.error) {
        gateResponse = {
          status: 'error',
          code: 'PLATE_UNREADABLE',
          message: apiData.error
        };
      } else {
        gateResponse = {
          status: 'ok',
          plate: apiData.license_plate || '',
          type: apiData.is_resident ? 'resident' : 'guest',
          building: apiData.building || null,
          confidence: apiData.confidence || 0,
          resident_name: apiData.resident_name || null  // Extra: display name in UI
        };
      }

    } catch (err) {
      console.error('[GateAPI Error]', err);
      showAlert(`Backend connection error: ${err.message}. Switched to Mock mode automatically.`, 'warning');
      // Graceful degradation: fall back to mock preset so demo doesn't break
      gateResponse = MOCK_SCENARIOS[currentScenarioKey]?.gate || MOCK_SCENARIOS.normal.gate;
    }
  }

  handleGateResult(gateResponse);
}

/**
 * 6. GATE OCR RESULT DISPATCHER
 * Evaluates plate, resident classification, and routes the vehicle.
 */
function handleGateResult(data) {
  console.log('[GateVision] OCR Result:', data);

  // CASE 1: OCR Business Error (PLATE_UNREADABLE, NO_VEHICLE, LOW_CONFIDENCE)
  if (data.status === 'error') {
    if (ocrPlateDisplay) {
      ocrPlateDisplay.textContent = 'ERR: ' + (data.code || 'UNKNOWN');
      ocrPlateDisplay.classList.add('error');
    }
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = 'OCR ERROR';
      ocrStatusBadge.className = 'badge badge-guest';
      ocrStatusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      ocrStatusBadge.style.color = '#f87171';
    }
    if (ocrVehicleType) ocrVehicleType.textContent = 'Unidentified';
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'None';
    if (routeInfoDisplay) routeInfoDisplay.textContent = 'Scan rejected';
    if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';

    logActivity('OCR ERROR', 'N/A', 'NONE', data.message || 'Image Recognition Error', 'denied');
    showAlert(`[${data.code}] ${data.message || 'Vehicle image recognition failed.'}`, 'error');
    return;
  }

  // Restore plate display styling
  if (ocrPlateDisplay) {
    ocrPlateDisplay.textContent = data.plate || 'UNKNOWN';
    ocrPlateDisplay.classList.remove('error');
  }

  // Update input field if not already matching
  if (customPlateInput && data.plate) {
    customPlateInput.value = data.plate;
  }

  // CASE 2: Entire Lot is 100% Full!
  if (window.parkingCanvas && window.parkingCanvas.isParkingLotFull()) {
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = 'ACCESS DENIED';
      ocrStatusBadge.className = 'badge badge-guest';
      ocrStatusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      ocrStatusBadge.style.color = '#f87171';
    }
    if (ocrVehicleType) {
      ocrVehicleType.textContent = data.type === 'resident' ? `Resident (Building ${data.building})` : 'Guest Visitor';
    }
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = '0/30 (LOT FULL)';
    if (routeInfoDisplay) routeInfoDisplay.textContent = 'Barrier locked. No bays available.';
    if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';

    logActivity('DENIED', data.plate || 'UNKNOWN', 'NONE', 'Campus 100% Full', 'denied');
    showAlert('🚨 CAMPUS IS 100% FULL (0/30). ENTRANCE BARRIER ACCESS DENIED!', 'error');
    return;
  }

  // CASE 3: Resident Vehicle (Auto-allocation to building elevator)
  if (data.type === 'resident' && data.building) {
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = `RESIDENT (BLDG ${data.building})`;
      ocrStatusBadge.className = 'badge badge-staff';
      ocrStatusBadge.style.background = '';
      ocrStatusBadge.style.color = '';
    }
    // Show resident name from DB if available (Live mode only)
    const nameLabel = data.resident_name ? ` — ${data.resident_name}` : '';
    if (ocrVehicleType) ocrVehicleType.textContent = `Resident · Bldg ${data.building}${nameLabel}`;

    currentPendingVehicle = data;
    allocateSlotAndRoute({
      type: 'resident',
      building: data.building,
      plate: data.plate
    });
    return;
  }

  // CASE 4: Guest Vehicle (Trigger inline building destination selector)
  if (data.type === 'guest') {
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = 'GUEST VISITOR';
      ocrStatusBadge.className = 'badge badge-guest';
      ocrStatusBadge.style.background = '';
      ocrStatusBadge.style.color = '';
    }
    if (ocrVehicleType) ocrVehicleType.textContent = 'Guest (Select Destination)';
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'Pending Selection...';
    if (routeInfoDisplay) routeInfoDisplay.textContent = 'Choose target building below';
    if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';

    currentPendingVehicle = data;
    showGuestCard();
  }
}

/**
 * 7. SMART ALLOCATION & A* ROUTING EXECUTION
 * Uses assignOptimalParkingSlot(), locks slot with reserveSlot(), and triggers car navigation animation.
 */
function allocateSlotAndRoute({ type, building, plate }) {
  if (!window.parkingCanvas) return;

  const result = window.parkingCanvas.assignOptimalParkingSlot({ type, building });

  if (result.status === 'FULL' || !result.slot) {
    showAlert(result.message || 'No available parking bay found.', 'error');
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'LOT FULL';
    logActivity('DENIED', plate, 'NONE', 'No Vacancy Available', 'denied');
    return;
  }

  const targetSlot = result.slot;
  const elevator = result.elevator;
  const distanceMeters = result.distanceMeters;
  const classificationText = type === 'resident' ? `Resident (Bldg ${building})` : `Guest (Bldg ${building})`;

  // 1. Lock slot state as RESERVED immediately (Prevents double-allocation)
  window.parkingCanvas.reserveSlot(targetSlot.id, plate);
  updateCapacityUI();

  // 2. Compute A* Path from Gate to Target Bay
  const startPoint = window.parkingCanvas.GATE_POSITION;
  const goalPoint = targetSlot.center;
  const calculatedPath = window.parkingCanvas.findAStarPath(startPoint, goalPoint, targetSlot);

  // 3. Log initial entry in activity audit trail
  logActivity('ENTERED', plate, targetSlot.id, classificationText, 'entry');

  // 4. Update Left Panel Details
  if (ocrSlotDisplay) {
    ocrSlotDisplay.textContent = `${targetSlot.id} (TRANSIT)`;
  }
  if (routeInfoDisplay) {
    routeInfoDisplay.textContent = `Driving to ${targetSlot.id} (${calculatedPath.length} waypoints)`;
  }
  if (elevatorInfoDisplay) {
    elevatorInfoDisplay.textContent = `${elevator.name} (~${distanceMeters}m walk)`;
  }

  // 5. Walking route payload
  const walkingInfo = {
    elevatorPos: elevator ? elevator.position : null,
    distanceMeters: distanceMeters
  };

  // 6. Trigger Smooth Car Driving Animation Along A* Path
  if (window.parkingCanvas.animateCarAlongRoute) {
    window.parkingCanvas.animateCarAlongRoute(calculatedPath, walkingInfo, targetSlot.id, () => {
      // Arrival callback: vehicle parked!
      if (ocrSlotDisplay) {
        ocrSlotDisplay.textContent = `${targetSlot.id} (PARKED)`;
      }
      if (routeInfoDisplay) {
        routeInfoDisplay.textContent = `Parked at ${targetSlot.id}. Route to ${elevator.name} active.`;
      }
      updateCapacityUI();
      logActivity('PARKED', plate, targetSlot.id, classificationText, 'parked');
    });
  } else {
    window.parkingCanvas.drawRoutingPath(calculatedPath, walkingInfo);
  }

  // 7. Overflow feedback alert
  if (result.overflow) {
    showAlert(result.message, 'warning');
  } else {
    showAlert(`Bay ${targetSlot.id} assigned! Vehicle navigating along optimal A* route.`, 'success');
  }
}

/**
 * 8. POLLING LOOP FOR LIVE BACKEND (GET /api/slots every 3 seconds)
 */
function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);

  pollingTimer = setInterval(async () => {
    if (USE_MOCK) return;

    try {
      // 1. Health check — GET /api/health
      const healthRes = await fetch('http://localhost:8000/api/health');
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        const modelReady = healthData.pipeline_ready;
        if (serverStatusDot) serverStatusDot.style.backgroundColor = modelReady ? '#22c55e' : '#f59e0b';
        if (serverStatusText) {
          serverStatusText.textContent = modelReady
            ? 'Server 8000: ONLINE — AI Models Ready ✓'
            : 'Server 8000: ONLINE — Models loading… (degraded)';
        }
      }

      // 2. Slots fetch
      const slotsRes = await fetch('http://localhost:8000/api/slots');
      if (slotsRes.ok) {
        const slotsData = await slotsRes.json();
        if (window.parkingCanvas && slotsData.slots) {
          window.parkingCanvas.updateSlotOccupancy(slotsData.slots);
          updateCapacityUI();
        }
      }
    } catch (err) {
      if (serverStatusDot) serverStatusDot.style.backgroundColor = '#ef4444';
      if (serverStatusText) serverStatusText.textContent = 'Server 8000: OFFLINE (Check python server)';
    }
  }, 3000);
}

// Global Slot Interaction Callbacks (Invoked from canvas Popover)
window.onSlotReleased = (slotId) => {
  updateCapacityUI();
  showAlert(`Bay ${slotId} released! Vacant for incoming vehicles.`, 'success');
  logActivity('CHECK-OUT', 'RELEASED', slotId, 'Vehicle Departure', 'checkout');
  if (ocrSlotDisplay && ocrSlotDisplay.textContent.includes(slotId)) {
    ocrSlotDisplay.textContent = 'None';
    routeInfoDisplay.textContent = 'Route cleared';
  }
};

window.onSlotOccupied = (slotId) => {
  updateCapacityUI();
  showAlert(`Bay ${slotId} manually parked.`, 'warning');
  logActivity('MANUAL PARK', 'MANUAL', slotId, 'Direct Park', 'parked');
};

// 9. EVENT LISTENERS INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
  // Mode Switcher (Mock vs Live)
  if (modeToggle) {
    modeToggle.addEventListener('change', (e) => {
      USE_MOCK = e.target.value === 'mock';
      if (serverStatusText) {
        serverStatusText.textContent = USE_MOCK ? 'Mock Mode (Simulation API)' : 'Connecting http://localhost:8000...';
      }
      if (!USE_MOCK) {
        startPolling();
      } else {
        if (serverStatusDot) serverStatusDot.style.backgroundColor = '#38bdf8';
        if (pollingTimer) clearInterval(pollingTimer);
      }
    });
  }

  // Simulation Tabs (Custom vs Presets)
  if (tabCustomEntry) {
    tabCustomEntry.addEventListener('click', () => {
      activeSimulationTab = 'custom';
      tabCustomEntry.classList.add('active');
      if (tabPresets) tabPresets.classList.remove('active');
      if (customEntrySection) customEntrySection.classList.remove('hidden');
      if (presetsSection) presetsSection.classList.add('hidden');
    });
  }

  if (tabPresets) {
    tabPresets.addEventListener('click', () => {
      activeSimulationTab = 'presets';
      tabPresets.classList.add('active');
      if (tabCustomEntry) tabCustomEntry.classList.remove('active');
      if (presetsSection) presetsSection.classList.remove('hidden');
      if (customEntrySection) customEntrySection.classList.add('hidden');
    });
  }

  // Random Plate Generator Button
  if (randomPlateBtn && customPlateInput) {
    randomPlateBtn.addEventListener('click', () => {
      customPlateInput.value = generateRandomPlate();
    });
  }

  // Scenario Presets Selector
  if (scenarioSelect) {
    scenarioSelect.addEventListener('change', (e) => {
      applyScenario(e.target.value);
    });
  }

  // Trigger Gate Scan Button
  if (simulateEntryBtn) {
    simulateEntryBtn.addEventListener('click', () => {
      triggerGateScan();
    });
  }

  // Real Image Upload Input
  if (imageUploadInput) {
    imageUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Always show image preview in camera feed
      const reader = new FileReader();
      reader.onload = (event) => {
        if (cameraPreviewImg) {
          cameraPreviewImg.src = event.target.result;
          cameraPreviewImg.style.display = 'block';
        }
      };
      reader.readAsDataURL(file);

      // Switch to Custom tab so user can see the result
      if (tabCustomEntry) tabCustomEntry.click();

      if (!USE_MOCK) {
        // ── LIVE MODE: send image to backend AI pipeline ─────────────────────
        // The API returns the real OCR'd plate; plate input will be auto-filled
        // by handleGateResult() via the 'plate' field in the normalized response.
        showAlert(`📷 Sending ${file.name} to AI backend…`, 'warning');
        triggerGateScan(file);
      } else {
        // ── MOCK MODE: show preview and populate plate field for manual review ─
        const generatedPlate = generateRandomPlate();
        if (customPlateInput) customPlateInput.value = generatedPlate;
        showAlert(`Photo loaded: ${file.name}. In Mock mode — edit plate if needed, then click Scan Entry.`, 'warning');
        // Do NOT auto-trigger scan; let user confirm the plate first
      }
    });
  }

  // Inline Guest Destination Choice Buttons
  document.querySelectorAll('.btn-building-choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const selectedBuilding = btn.getAttribute('data-building') || 'A';
      hideGuestCard();

      if (currentPendingVehicle) {
        allocateSlotAndRoute({
          type: 'guest',
          building: selectedBuilding,
          plate: currentPendingVehicle.plate
        });
      }
    });
  });

  // Cancel/Dismiss Guest Selector
  if (cancelGuestBtn) {
    cancelGuestBtn.addEventListener('click', () => {
      hideGuestCard();
      if (ocrStatusBadge) {
        ocrStatusBadge.textContent = 'Cancelled';
      }
    });
  }

  // Campus Blueprint JSON Upload
  if (mapUploadInput) {
    mapUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const config = JSON.parse(event.target.result);
            if (window.parkingCanvas && window.parkingCanvas.loadParkingMapConfig) {
              const success = window.parkingCanvas.loadParkingMapConfig(config);
              if (success) {
                applyScenario(currentScenarioKey);
                showAlert(`Successfully loaded campus blueprint: ${config.campus_name || file.name}`, 'success');
              } else {
                showAlert('Invalid JSON parking map blueprint structure.', 'error');
              }
            }
          } catch (err) {
            showAlert('Error parsing JSON configuration: ' + err.message, 'error');
          }
        };
        reader.readAsText(file);
      }
    });
  }

  // Reset Route Button
  if (clearRouteBtn) {
    clearRouteBtn.addEventListener('click', () => {
      if (window.parkingCanvas) {
        // Release any reserved slot from current scan session
        const allSlots = window.parkingCanvas.getActiveSlots();
        allSlots.forEach((s) => {
          if (s.isReserved) {
            s.isReserved = false;
            s.occupied = false;
            s.reservedPlate = null;
          }
        });
        window.parkingCanvas.initParkingMap();
        updateCapacityUI();
      }
      clearAlert();
      hideGuestCard();
      currentPendingVehicle = null;
      if (routeInfoDisplay) routeInfoDisplay.textContent = 'Awaiting vehicle scan';
      if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';
      if (ocrSlotDisplay) ocrSlotDisplay.textContent = '--';
      if (ocrPlateDisplay) {
        ocrPlateDisplay.textContent = '--';
        ocrPlateDisplay.classList.remove('error');
      }
      if (ocrStatusBadge) {
        ocrStatusBadge.textContent = 'Awaiting Vehicle';
        ocrStatusBadge.className = 'badge badge-guest';
        ocrStatusBadge.style.background = '';
        ocrStatusBadge.style.color = '';
      }
      if (ocrVehicleType) ocrVehicleType.textContent = '--';
    });
  }

  // Free All 30 Bays Button
  if (freeAllBaysBtn) {
    freeAllBaysBtn.addEventListener('click', () => {
      if (window.parkingCanvas && window.parkingCanvas.freeAllBays) {
        window.parkingCanvas.freeAllBays();
        updateCapacityUI();
        clearAlert();
        hideGuestCard();
        showAlert('All 30 bays across campus have been set to vacant.', 'success');
        if (routeInfoDisplay) routeInfoDisplay.textContent = 'Awaiting vehicle scan';
        if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';
        if (ocrSlotDisplay) ocrSlotDisplay.textContent = '--';
        if (ocrPlateDisplay) {
          ocrPlateDisplay.textContent = '--';
          ocrPlateDisplay.classList.remove('error');
        }
        if (ocrStatusBadge) {
          ocrStatusBadge.textContent = 'Awaiting Vehicle';
          ocrStatusBadge.className = 'badge badge-guest';
          ocrStatusBadge.style.background = '';
          ocrStatusBadge.style.color = '';
        }
        if (ocrVehicleType) ocrVehicleType.textContent = '--';
      }
    });
  }

  // Load external JSON configurations if available
  (async function tryLoadExternalConfig() {
    try {
      const res = await fetch('parking_map.json');
      if (res.ok) {
        const mapData = await res.json();
        if (window.parkingCanvas && window.parkingCanvas.loadParkingMapConfig) {
          window.parkingCanvas.loadParkingMapConfig(mapData);
        }
      }
    } catch (_) {
      // Local file fallback
    }

    try {
      const resScen = await fetch('mock_scenarios.json');
      if (resScen.ok) {
        const scenData = await resScen.json();
        if (scenData && scenData.scenarios) {
          Object.assign(MOCK_SCENARIOS, scenData.scenarios);
        }
      }
    } catch (_) {
      // Local fallback
    }
  })();

  // Initial Scenario Setup (Wait in ready state)
  applyScenario('normal');
});
