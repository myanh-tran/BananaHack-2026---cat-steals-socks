/**
 * js/main.js
 * Master Client Controller for SmartPark Campus.
 * Implements:
 * - Person 3 Hackathon Contract (USE_MOCK flag, Live FastAPI connectivity)
 * - 8 Test Scenarios (All 30 bays full, Zone A full, Guest full, OCR errors, Resident B)
 * - True RESERVED slot mechanics (Prevents double allocation)
 * - Overflow re-routing when a resident's building is 100% full
 * - Real image upload & camera preview
 * - 3-second polling loop for GET /api/slots
 */

// Global State
let USE_MOCK = true;
let currentScenarioKey = 'normal';
let pollingTimer = null;
let currentPendingVehicle = null;

// Built-in Scenarios (Fallback & Instant Demo)
const MOCK_SCENARIOS = {
  normal: {
    name: 'Bình thường (Còn nhiều chỗ)',
    gate: { status: 'ok', plate: '51A12345', type: 'resident', building: 'A', confidence: 0.94 },
    occupied: ['A-01', 'A-04', 'B-02', 'B-05', 'C-01', 'C-03', 'D-02', 'D-04', 'G-01', 'G-03']
  },
  zone_a_full: {
    name: 'Tòa A đầy 100% (Điều phối sang tòa khác)',
    gate: { status: 'ok', plate: '51A99999', type: 'resident', building: 'A', confidence: 0.92 },
    occupied: ['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'B-03', 'C-01', 'D-02', 'G-01']
  },
  guest_zone_full: {
    name: 'Khu xe khách G đầy 100%',
    gate: { status: 'ok', plate: '29A98246', type: 'guest', building: null, confidence: 0.89 },
    occupied: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'A-02', 'B-03', 'C-04']
  },
  lot_full: {
    name: 'CẢ BÃI XE ĐẦY 100% (FULL)',
    gate: { status: 'ok', plate: '30E88888', type: 'guest', building: null, confidence: 0.96 },
    all_occupied: true
  },
  only_one_slot: {
    name: 'Chỉ còn đúng 1 ô trống toàn bãi (D-06)',
    gate: { status: 'ok', plate: '43A67890', type: 'resident', building: 'B', confidence: 0.91 },
    all_occupied_except: ['D-06']
  },
  resident_building_b: {
    name: 'Cư dân Tòa B (51B56789)',
    gate: { status: 'ok', plate: '51B56789', type: 'resident', building: 'B', confidence: 0.95 },
    occupied: ['B-01', 'B-03', 'A-01', 'C-02', 'D-01']
  },
  ocr_unreadable: {
    name: 'Lỗi OCR: Không đọc được biển số',
    gate: { status: 'error', code: 'PLATE_UNREADABLE', message: 'Không đọc được biển số, vui lòng chụp lại' }
  },
  ocr_no_vehicle: {
    name: 'Lỗi OCR: Không phát hiện xe',
    gate: { status: 'error', code: 'NO_VEHICLE', message: 'Không phát hiện xe trước rào chắn' }
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

const guestModal = document.getElementById('guestModal');
const destinationSelect = document.getElementById('destinationSelect');
const findParkingBtn = document.getElementById('findParkingBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const mapUploadInput = document.getElementById('mapUploadInput');

/**
 * 1. CAPACITY & OCCUPANCY UI UPDATE
 */
function updateCapacityUI() {
  if (!window.parkingCanvas) return;
  const stats = window.parkingCanvas.getParkingStats();
  if (capacityBadge) {
    capacityBadge.textContent = `Available: ${stats.free}/${stats.total} bays`;
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
  alertContainer.style.display = 'block';
  alertContainer.className = `lot-alert-banner ${type}`;
  alertContainer.innerHTML = `<span>⚠️</span> <span>${message}</span>`;
}

function clearAlert() {
  if (!alertContainer) return;
  alertContainer.style.display = 'none';
  alertContainer.innerHTML = '';
}

/**
 * 3. SCENARIO LOADER (Mục 9 Kế hoạch)
 * Populates 30 slots state based on selected test scenario.
 */
function applyScenario(scenarioKey) {
  currentScenarioKey = scenarioKey;
  clearAlert();

  const scenario = MOCK_SCENARIOS[scenarioKey];
  if (!scenario || !window.parkingCanvas) return;

  const allSlots = window.parkingCanvas.getActiveSlots();

  if (scenario.all_occupied) {
    // 100% Full Lot
    allSlots.forEach((s) => {
      s.occupied = true;
      s.isReserved = false;
    });
  } else if (scenario.all_occupied_except) {
    // Only 1 slot free
    allSlots.forEach((s) => {
      s.occupied = !scenario.all_occupied_except.includes(s.id);
      s.isReserved = false;
    });
  } else if (scenario.occupied || scenario.occupied_slots) {
    // Standard occupied list
    const occupiedList = scenario.occupied || scenario.occupied_slots || [];
    allSlots.forEach((s) => {
      s.occupied = occupiedList.includes(s.id);
      s.isReserved = false;
    });
  }

  window.parkingCanvas.initParkingMap();
  updateCapacityUI();

  // Reset route and previews
  if (cameraPreviewImg) cameraPreviewImg.style.display = 'none';
  if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'None';
  if (routeInfoDisplay) routeInfoDisplay.textContent = 'Awaiting car';
  if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';
}

/**
 * 4. GATE OCR HANDLER (Supports Real API & Mock)
 * Calls POST /api/gate or resolves mock payload.
 *
 * @param {File|null} uploadedImageFile
 */
async function triggerGateScan(uploadedImageFile = null) {
  clearAlert();
  console.log(`[GateVision] Scanning vehicle... Mode: ${USE_MOCK ? 'MOCK' : 'LIVE API'}`);

  let gateResponse = null;

  if (USE_MOCK) {
    // Get scenario mock data
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
      showAlert(`Lỗi kết nối Backend: ${err.message}. Đã bật fallback Mock.`, 'warning');
      gateResponse = MOCK_SCENARIOS.normal.gate;
    }
  }

  handleGateResult(gateResponse);
}

/**
 * 5. GATE OCR RESULT DISPATCHER
 * Evaluates plate, resident status, and routes the vehicle.
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
    showAlert(`[${data.code}] ${data.message || 'Lỗi nhận dạng ảnh xe.'}`, 'error');
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
    if (ocrVehicleType) ocrVehicleType.textContent = data.type === 'resident' ? `Cư dân Tòa ${data.building}` : 'Khách vãng lai';
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = '0/30 (BÃI KÍN CHỖ)';
    if (routeInfoDisplay) routeInfoDisplay.textContent = 'Barrier đóng. Không thể cấp chỗ.';
    showAlert('🚨 RẤT TIẾC, TOÀN BỘ BÃI ĐỖ XE ĐÃ ĐẦY 100% (0/30). BARRIER TỪ CHỐI MỞ CỔNG!', 'error');
    return;
  }

  // CASE 3: Resident Vehicle (Auto-allocation to building)
  if (data.type === 'resident' && data.building) {
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = `RESIDENT (TÒA ${data.building})`;
      ocrStatusBadge.className = 'badge badge-staff';
    }
    if (ocrVehicleType) ocrVehicleType.textContent = `Cư dân Tòa ${data.building}`;

    currentPendingVehicle = data;
    allocateSlotAndRoute({
      type: 'resident',
      building: data.building,
      plate: data.plate
    });
    return;
  }

  // CASE 4: Guest Vehicle (Prompt modal)
  if (data.type === 'guest') {
    if (ocrStatusBadge) {
      ocrStatusBadge.textContent = 'GUEST VISITOR';
      ocrStatusBadge.className = 'badge badge-guest';
    }
    if (ocrVehicleType) ocrVehicleType.textContent = 'Khách vãng lai (Cần chọn tòa)';

    currentPendingVehicle = data;
    showGuestModal();
  }
}

/**
 * 6. SMART ALLOCATION & A* ROUTING EXECUTION
 * Uses assignOptimalParkingSlot(), locks slot with reserveSlot(), and draws A* path.
 */
function allocateSlotAndRoute({ type, building, plate }) {
  if (!window.parkingCanvas) return;

  const result = window.parkingCanvas.assignOptimalParkingSlot({ type, building });

  if (result.status === 'FULL' || !result.slot) {
    showAlert(result.message || 'Không tìm được chỗ đỗ xe trống.', 'error');
    if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'KÍN CHỖ';
    return;
  }

  const targetSlot = result.slot;
  const elevator = result.elevator;
  const distanceMeters = result.distanceMeters;

  // 1. Lock slot state as RESERVED immediately
  window.parkingCanvas.reserveSlot(targetSlot.id, plate);
  updateCapacityUI();

  // 2. Compute A* Path from Gate to Bay
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
    elevatorInfoDisplay.textContent = `${elevator.name} (~${distanceMeters}m đi bộ)`;
  }

  // 5. Overflow feedback alert (If resident's building was full)
  if (result.overflow) {
    showAlert(result.message, 'warning');
  } else {
    showAlert(`Đã cấp thành công ô ${targetSlot.id}. Barrier mở, xin mời xe vào!`, 'success');
  }
}

/**
 * 7. MODAL DISPLAY TOGGLES
 */
function showGuestModal() {
  if (guestModal) {
    guestModal.classList.remove('hidden');
    guestModal.classList.add('show');
  }
}

function hideGuestModal() {
  if (guestModal) {
    guestModal.classList.remove('show');
    guestModal.classList.add('hidden');
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
        serverStatusText.textContent = USE_MOCK ? 'USE_MOCK: Active (Simulated API)' : 'Connecting http://localhost:8000...';
      }
      if (!USE_MOCK) {
        startPolling();
      } else {
        if (serverStatusDot) serverStatusDot.style.backgroundColor = '#38bdf8';
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

  // Find Parking in Guest Modal
  if (findParkingBtn) {
    findParkingBtn.addEventListener('click', () => {
      const selectedBuilding = destinationSelect ? destinationSelect.value : 'A';
      hideGuestModal();

      if (currentPendingVehicle) {
        allocateSlotAndRoute({
          type: 'guest',
          building: selectedBuilding,
          plate: currentPendingVehicle.plate
        });
      }
    });
  }

  // Close Modal
  if (cancelModalBtn) {
    cancelModalBtn.addEventListener('click', () => {
      hideGuestModal();
    });
  }

  // Admin Custom Campus Map JSON Upload
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
                showAlert(`Đã nạp sơ đồ bãi xe thành công: ${config.campus_name || file.name}`, 'success');
              } else {
                showAlert('File JSON không đúng cấu trúc sơ đồ bãi xe.', 'error');
              }
            }
          } catch (err) {
            showAlert('Lỗi đọc file cấu hình JSON: ' + err.message, 'error');
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
      currentPendingVehicle = null;
      if (routeInfoDisplay) routeInfoDisplay.textContent = 'None (Waiting for car)';
      if (elevatorInfoDisplay) elevatorInfoDisplay.textContent = '--';
      if (ocrSlotDisplay) ocrSlotDisplay.textContent = 'None';
    });
  }

  // Try loading external JSON configurations if hosted on server
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
      // Local protocol fallback
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

  // Initial Scenario Setup
  applyScenario('normal');

  // Trigger initial demo vehicle scan
  setTimeout(() => {
    triggerGateScan();
  }, 500);
});
