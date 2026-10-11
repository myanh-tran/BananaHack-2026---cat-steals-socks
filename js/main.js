/**
 * js/main.js
 * Master Client Controller for SmartPark Campus (Phase 1 Refactored).
 * Features:
 * - 100% Professional English UI & feedback
 * - Inline Guest Destination Selection (No disruptive full-screen modal)
 * - Clean Gate Terminal & Interactive Campus Map split
 * - Presets for 8 test scenarios
 * - Real image upload support & Fast Mock Mode
 * - 3-second polling loop for Live FastAPI backend (:8000)
 */

// Global State
let USE_MOCK = true;
let currentScenarioKey = 'normal';
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
const imageUploadInput = document.getElementById('imageUploadInput');
const mapUploadInput = document.getElementById('mapUploadInput');

// Inline Guest Destination Selector
const guestDestinationCard = document.getElementById('guestDestinationCard');
const cancelGuestBtn = document.getElementById('cancelGuestBtn');

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
 * 5. GATE OCR HANDLER (Supports Real API & Mock)
 * Calls POST /api/gate or resolves mock payload.
 *
 * @param {File|null} uploadedImageFile
 */
async function triggerGateScan(uploadedImageFile = null) {
  clearAlert();
  hideGuestCard();
  console.log(`[GateVision] Scanning vehicle... Mode: ${USE_MOCK ? 'MOCK' : 'LIVE API'}`);

  let gateResponse = null;

  if (USE_MOCK) {
    // Mock simulation payload
    const scenario = MOCK_SCENARIOS[currentScenarioKey] || MOCK_SCENARIOS.normal;
    gateResponse = scenario.gate;
  } else {
    // Live Server Call (POST /api/gate)
    try {
      const formData = new FormData();
      if (uploadedImageFile) {
        formData.append('image', uploadedImageFile);
      } else {
        // Create dummy blob image if no file chosen
        const dummyCanvas = document.createElement('canvas');
        dummyCanvas.width = 100;
        dummyCanvas.height = 100;
        const blob = await new Promise((res) => dummyCanvas.toBlob(res, 'image/jpeg'));
        formData.append('image', blob, 'sample_car.jpg');
      }

      const res = await fetch('http://localhost:8000/api/gate', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      gateResponse = await res.json();
    } catch (err) {
      console.error('[GateAPI Error]', err);
      showAlert(`Backend connection error: ${err.message}. Switched to Mock mode.`, 'warning');
      gateResponse = MOCK_SCENARIOS.normal.gate;
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

    showAlert(`[${data.code}] ${data.message || 'Vehicle image recognition failed.'}`, 'error');
    return;
  }

  // Restore plate display styling
  if (ocrPlateDisplay) {
    ocrPlateDisplay.textContent = data.plate || 'UNKNOWN';
    ocrPlateDisplay.classList.remove('error');
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
    if (ocrVehicleType) ocrVehicleType.textContent = `Resident (Building ${data.building})`;

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
 * Uses assignOptimalParkingSlot(), locks slot with reserveSlot(), and draws A* path.
 */
function allocateSlotAndRoute({ type, building, plate }) {
  if (!window.parkingCanvas) return;

  const result = window.parkingCanvas.assignOptimalParkingSlot({ type, building });

  if (result.status === 'FULL' || !result.slot) {
    showAlert(result.message || 'No available parking bay found.', 'error');
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'LOT FULL';
    return;
  }

  const targetSlot = result.slot;
  const elevator = result.elevator;
  const distanceMeters = result.distanceMeters;

  // 1. Lock slot state as RESERVED immediately (Prevents double-allocation)
  window.parkingCanvas.reserveSlot(targetSlot.id, plate);
  updateCapacityUI();

  // 2. Compute A* Path from Gate to Target Bay
  const startPoint = window.parkingCanvas.GATE_POSITION;
  const goalPoint = targetSlot.center;
  const calculatedPath = window.parkingCanvas.findAStarPath(startPoint, goalPoint, targetSlot);

  // 3. Draw Vehicular A* Path + Pedestrian Walking Line to Elevator
  const walkingInfo = {
    elevatorPos: elevator ? elevator.position : null,
    distanceMeters: distanceMeters
  };

  window.parkingCanvas.drawRoutingPath(calculatedPath, walkingInfo);

  // 4. Update Left Panel Details
  if (ocrSlotDisplay) {
    ocrSlotDisplay.textContent = `${targetSlot.id} (RESERVED)`;
  }
  if (routeInfoDisplay) {
    routeInfoDisplay.textContent = `A* Path (${calculatedPath.length} waypoints) -> ${targetSlot.id}`;
  }
  if (elevatorInfoDisplay) {
    elevatorInfoDisplay.textContent = `${elevator.name} (~${distanceMeters}m walk)`;
  }

  // 5. Overflow feedback alert
  if (result.overflow) {
    showAlert(result.message, 'warning');
  } else {
    showAlert(`Bay ${targetSlot.id} successfully allocated! Barrier opened.`, 'success');
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
      // 1. Health check
      const healthRes = await fetch('http://localhost:8000/api/health');
      if (healthRes.ok) {
        if (serverStatusDot) serverStatusDot.style.backgroundColor = '#22c55e';
        if (serverStatusText) serverStatusText.textContent = 'Server 8000: ONLINE (Model Ready)';
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

  // Scenario Selector
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
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (cameraPreviewImg) {
            cameraPreviewImg.src = event.target.result;
            cameraPreviewImg.style.display = 'block';
          }
        };
        reader.readAsDataURL(file);

        // Send uploaded image to gate scan
        triggerGateScan(file);
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
