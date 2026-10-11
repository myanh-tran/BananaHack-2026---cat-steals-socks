/**
 * js/canvas.js
 * High-performance 2D Canvas Renderer and A* Routing Engine for SmartPark Campus.
 * Supports:
 * - 30-slot realistic campus layout (A-01..A-06, B-01..B-06, C-01..C-06, D-01..D-06, G-01..G-06)
 * - Three slot states: FREE, OCCUPIED, and RESERVED (gold/amber)
 * - Fixed elevators for Buildings A, B, C, D
 * - Fixed structural pillars & hazard zones
 * - Smart slot allocation (Resident priority, Guest zone, Nearest-to-elevator, Overflow handling)
 * - Full parking lot detection (100% full capacity handling)
 */

const canvas = document.getElementById('parkingMap');
const ctx = canvas ? canvas.getContext('2d') : null;

// Discrete grid settings for A* Algorithm
const GRID_SIZE = 20;
const GRID_COLS = canvas ? Math.floor(canvas.width / GRID_SIZE) : 42;
const GRID_ROWS = canvas ? Math.floor(canvas.height / GRID_SIZE) : 31;

// Entry Gate Location
let GATE_POSITION = [65, 565];

// Fixed Building Elevators (Positioned cleanly outside parking bay bounds)
let elevators = [
  { id: 'ELV-A', name: 'Elevator A', zone: 'A', position: [295, 30] },
  { id: 'ELV-B', name: 'Elevator B', zone: 'B', position: [695, 30] },
  { id: 'ELV-C', name: 'Elevator C', zone: 'C', position: [295, 520] },
  { id: 'ELV-D', name: 'Elevator D', zone: 'D', position: [695, 520] }
];

// Fixed Obstacles (Structural Pillars in corridors & Hazard in clear lane)
let fixedObstacles = [
  { id: 'PIL-1', type: 'pillar', x: 235, y: 165, width: 20, height: 20, label: 'P1' },
  { id: 'PIL-2', type: 'pillar', x: 635, y: 165, width: 20, height: 20, label: 'P2' },
  { id: 'PIL-3', type: 'pillar', x: 235, y: 370, width: 20, height: 20, label: 'P3' },
  { id: 'PIL-4', type: 'pillar', x: 635, y: 370, width: 20, height: 20, label: 'P4' },
  { id: 'HAZ-1', type: 'hazard', x: 435, y: 355, width: 28, height: 28, label: '🚧' }
];

// Campus Zone Blueprint definition (30 Slots Total - non-overlapping start positions)
let defaultCampusZones = [
  {
    name: 'Building A',
    prefix: 'A',
    type: 'resident',
    count: 6,
    startX: 85,
    startY: 65,
    slotWidth: 46,
    slotHeight: 65,
    slotGap: 10,
    orientation: 'top'
  },
  {
    name: 'Building B',
    prefix: 'B',
    type: 'resident',
    count: 6,
    startX: 485,
    startY: 65,
    slotWidth: 46,
    slotHeight: 65,
    slotGap: 10,
    orientation: 'top'
  },
  {
    name: 'Guest Zone',
    prefix: 'G',
    type: 'guest',
    count: 6,
    startX: 245,
    startY: 230,
    slotWidth: 50,
    slotHeight: 65,
    slotGap: 14,
    orientation: 'middle'
  },
  {
    name: 'Building C',
    prefix: 'C',
    type: 'resident',
    count: 6,
    startX: 85,
    startY: 425,
    slotWidth: 46,
    slotHeight: 65,
    slotGap: 10,
    orientation: 'bottom'
  },
  {
    name: 'Building D',
    prefix: 'D',
    type: 'resident',
    count: 6,
    startX: 485,
    startY: 425,
    slotWidth: 46,
    slotHeight: 65,
    slotGap: 10,
    orientation: 'bottom'
  }
];

/**
 * 1. CAMPUS LAYOUT INITIALIZER
 * Generates initial 30 slots from blueprint definition.
 */
function buildCampusSlots(zonesConfig = defaultCampusZones) {
  const slots = [];

  zonesConfig.forEach((zone) => {
    for (let i = 0; i < zone.count; i++) {
      const num = String(i + 1).padStart(2, '0');
      const slotId = `${zone.prefix}-${num}`;
      const x = zone.startX + i * (zone.slotWidth + zone.slotGap);
      const y = zone.startY;

      const coordinates = [
        [x, y],
        [x + zone.slotWidth, y],
        [x + zone.slotWidth, y + zone.slotHeight],
        [x, y + zone.slotHeight]
      ];

      const center = [
        Math.round(x + zone.slotWidth / 2),
        Math.round(y + zone.slotHeight / 2)
      ];

      slots.push({
        id: slotId,
        coordinates,
        center,
        occupied: false,
        isReserved: false,
        reservedPlate: null,
        zone: zone.prefix, // "A", "B", "C", "D", "G"
        zoneName: zone.name,
        type: zone.type, // "resident" or "guest"
        width: zone.slotWidth,
        height: zone.slotHeight,
        orientation: zone.orientation
      });
    }
  });

  return slots;
}

// Active runtime parking lot state (30 Slots)
let activeParkingSlots = buildCampusSlots();

/**
 * Apply slot states (from Backend / Mock Scenario)
 * @param {Array<{id: string, occupied: boolean, confidence?: number}>} slotData
 */
function updateSlotOccupancy(slotData) {
  if (!Array.isArray(slotData)) return;

  const dataMap = new Map();
  slotData.forEach((s) => dataMap.set(s.id, s));

  activeParkingSlots.forEach((slot) => {
    if (dataMap.has(slot.id)) {
      const incoming = dataMap.get(slot.id);
      // Keep reserved status if not yet confirmed occupied
      if (!slot.isReserved) {
        slot.occupied = Boolean(incoming.occupied);
      } else if (incoming.occupied) {
        // Car has docked into reserved bay!
        slot.isReserved = false;
        slot.occupied = true;
      }
      slot.confidence = incoming.confidence ?? 0.95;
    }
  });

  initParkingMap();
}

/**
 * Marks a slot as RESERVED for an approaching vehicle.
 * Prevents subsequent cars from receiving the same slot.
 * @param {string} slotId
 * @param {string} plateNumber
 */
function reserveSlot(slotId, plateNumber = '') {
  const target = activeParkingSlots.find((s) => s.id === slotId);
  if (target) {
    target.isReserved = true;
    target.occupied = true; // Counted as unavailable
    target.reservedPlate = plateNumber;
    console.log(`[ParkingManager] Slot ${slotId} is now RESERVED for ${plateNumber}`);
    redrawCurrentMap();
    return true;
  }
  return false;
}

/**
 * Releases a reserved or occupied slot back to free state (Vehicle Check-Out).
 */
function releaseSlot(slotId) {
  const target = activeParkingSlots.find((s) => s.id === slotId);
  if (target) {
    target.isReserved = false;
    target.occupied = false;
    target.reservedPlate = null;
    target.parkedPlate = null;
    console.log(`[ParkingManager] Slot ${slotId} released back to FREE`);
    redrawCurrentMap();
    return true;
  }
  return false;
}

/**
 * Manually marks a slot as occupied.
 */
function occupySlot(slotId, plateNumber = 'MANUAL-PARK') {
  const target = activeParkingSlots.find((s) => s.id === slotId);
  if (target) {
    target.isReserved = false;
    target.occupied = true;
    target.parkedPlate = plateNumber;
    target.reservedPlate = null;
    console.log(`[ParkingManager] Slot ${slotId} occupied by ${plateNumber}`);
    redrawCurrentMap();
    return true;
  }
  return false;
}

/**
 * Frees all 30 parking bays across campus.
 */
function freeAllBays() {
  activeParkingSlots.forEach((s) => {
    s.isReserved = false;
    s.occupied = false;
    s.reservedPlate = null;
    s.parkedPlate = null;
  });
  currentDrawnPath = null;
  currentWalkingInfo = null;
  selectedSlot = null;
  hideBayInspector();
  redrawCurrentMap();
  console.log('[ParkingManager] All 30 bays freed.');
}

/**
 * Checks if the entire parking campus is 100% full.
 * @returns {boolean}
 */
function isParkingLotFull() {
  const freeSlots = activeParkingSlots.filter((s) => !s.occupied && !s.isReserved);
  return freeSlots.length === 0;
}

/**
 * Gets capacity statistics across zones.
 */
function getParkingStats() {
  const total = activeParkingSlots.length;
  const occupied = activeParkingSlots.filter((s) => s.occupied && !s.isReserved).length;
  const reserved = activeParkingSlots.filter((s) => s.isReserved).length;
  const free = total - occupied - reserved;

  const zones = ['A', 'B', 'C', 'D', 'G'].map((z) => {
    const zoneSlots = activeParkingSlots.filter((s) => s.zone === z);
    const zFree = zoneSlots.filter((s) => !s.occupied && !s.isReserved).length;
    return { zone: z, total: zoneSlots.length, free: zFree };
  });

  return { total, occupied, reserved, free, zones };
}

/**
 * 2. SMART PARKING SLOT ALLOCATION ALGORITHM
 * Prioritizes:
 * - Residents -> Closest available slot in their building to their elevator.
 *   If full -> Closest available overflow slot in other buildings with walking distance.
 * - Guests -> Closest available slot in Guest Zone G.
 *   If destination specified -> Closest available slot to that elevator.
 * - Checks entire lot capacity (Returns null if 100% full).
 *
 * @param {Object} query
 * @param {string} query.type - 'resident' or 'guest'
 * @param {string} query.building - 'A', 'B', 'C', 'D' or null
 * @returns {Object|null}
 */
function assignOptimalParkingSlot({ type = 'guest', building = null } = {}) {
  // 1. Check if the entire parking lot is full
  if (isParkingLotFull()) {
    return {
      status: 'FULL',
      slot: null,
      message: 'Campus parking is 100% full (0/30 vacant bays). Entry barrier locked.'
    };
  }

  // Determine target elevator based on building or default to A
  const elevatorZone = building || 'A';
  const targetElevator = elevators.find((e) => e.zone === elevatorZone) || elevators[0];

  const calculateDistance = (slot) => {
    const pxDist = Math.hypot(
      slot.center[0] - targetElevator.position[0],
      slot.center[1] - targetElevator.position[1]
    );
    return {
      slot,
      distancePx: pxDist,
      distanceMeters: Math.round(pxDist * 0.22)
    };
  };

  // CASE A: Resident Vehicle
  if (type === 'resident' && building) {
    // 1. Try to find free slot within resident's own building zone
    const residentFreeSlots = activeParkingSlots
      .filter((s) => s.zone === building && !s.occupied && !s.isReserved)
      .map(calculateDistance)
      .sort((a, b) => a.distancePx - b.distancePx);

    if (residentFreeSlots.length > 0) {
      return {
        status: 'OK',
        slot: residentFreeSlots[0].slot,
        elevator: targetElevator,
        distanceMeters: residentFreeSlots[0].distanceMeters,
        overflow: false,
        message: `Allocated Bay ${residentFreeSlots[0].slot.id} (Building ${building}) - approx. ${residentFreeSlots[0].distanceMeters}m to ${targetElevator.name}.`
      };
    }

    // 2. Resident zone is FULL -> Overflow reallocation to closest neighboring bay
    const overflowFreeSlots = activeParkingSlots
      .filter((s) => !s.occupied && !s.isReserved)
      .map(calculateDistance)
      .sort((a, b) => a.distancePx - b.distancePx);

    if (overflowFreeSlots.length > 0) {
      const best = overflowFreeSlots[0];
      return {
        status: 'OVERFLOW',
        slot: best.slot,
        elevator: targetElevator,
        distanceMeters: best.distanceMeters,
        overflow: true,
        message: `Building ${building} is 100% full! Re-routed to Bay ${best.slot.id} (~${best.distanceMeters}m walk to Elevator ${building}).`
      };
    }
  }

  // CASE B: Guest Vehicle
  if (type === 'guest') {
    // 1. Check if Guest Zone G has free slots
    const guestZoneFree = activeParkingSlots
      .filter((s) => s.zone === 'G' && !s.occupied && !s.isReserved)
      .map(calculateDistance)
      .sort((a, b) => a.distancePx - b.distancePx);

    if (guestZoneFree.length > 0) {
      const best = guestZoneFree[0];
      return {
        status: 'OK',
        slot: best.slot,
        elevator: targetElevator,
        distanceMeters: best.distanceMeters,
        overflow: false,
        message: `Allocated Guest Bay ${best.slot.id} (Zone G) - approx. ${best.distanceMeters}m to ${targetElevator.name}.`
      };
    }

    // 2. Guest Zone G is FULL -> Assign nearest available bay across the entire campus
    const generalFreeSlots = activeParkingSlots
      .filter((s) => !s.occupied && !s.isReserved)
      .map(calculateDistance)
      .sort((a, b) => a.distancePx - b.distancePx);

    if (generalFreeSlots.length > 0) {
      const best = generalFreeSlots[0];
      return {
        status: 'GUEST_OVERFLOW',
        slot: best.slot,
        elevator: targetElevator,
        distanceMeters: best.distanceMeters,
        overflow: true,
        message: `Guest Zone G is full! Re-routed to Bay ${best.slot.id} (Zone ${best.slot.zone}) - approx. ${best.distanceMeters}m to ${targetElevator.name}.`
      };
    }
  }

  return { status: 'FULL', slot: null, message: 'Campus parking is currently full.' };
}

/**
 * 3. A* NAVIGATION GRID & PATHFINDING
 */
function buildNavigationGrid(slots, targetSlot = null) {
  const grid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(1));

  const isDrivableAisle = (gx, gy) => {
    const px = gx * GRID_SIZE + GRID_SIZE / 2;
    const py = gy * GRID_SIZE + GRID_SIZE / 2;

    // Driving corridors (continuous connection to parking bays)
    const inTopCorridor = py >= 130 && py <= 220; // Continuous access to Zone A, Zone B and top of Zone G
    const inMiddleCorridor = py >= 295 && py <= 360; // Access to Zone G and bypass lane
    const inBottomCorridor = py >= 355 && py <= 425; // Continuous access to Zone C & Zone D
    const inGateLane = py >= 490 && py <= 585 && px <= 460; // Gate entrance lane

    // Vertical lanes (connecting all corridors)
    const inLeftLane = px >= 35 && px <= 95 && py >= 130 && py <= 585;
    const inCenterLane = px >= 415 && px <= 475 && py >= 130 && py <= 585;
    const inRightLane = px >= 755 && px <= 810 && py >= 130 && py <= 585;

    return inTopCorridor || inMiddleCorridor || inBottomCorridor || inGateLane || inLeftLane || inCenterLane || inRightLane;
  };

  // Mark drivable lanes as 0 (Walkable)
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isDrivableAisle(c, r)) {
        grid[r][c] = 0;
      }
    }
  }

  // Mark Fixed Obstacles (Pillars & Hazard) as blocked (1)
  fixedObstacles.forEach((obs) => {
    const minX = Math.floor(obs.x / GRID_SIZE);
    const maxX = Math.ceil((obs.x + obs.width) / GRID_SIZE);
    const minY = Math.floor(obs.y / GRID_SIZE);
    const maxY = Math.ceil((obs.y + obs.height) / GRID_SIZE);

    for (let r = minY; r < maxY; r++) {
      for (let c = minX; c < maxX; c++) {
        if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
          grid[r][c] = 1;
        }
      }
    }
  });

  // Mark all parking bays as blocked (1) EXCEPT the target bay
  slots.forEach((slot) => {
    const isTarget = targetSlot && slot.id === targetSlot.id;
    const minX = Math.floor(slot.coordinates[0][0] / GRID_SIZE);
    const maxX = Math.ceil(slot.coordinates[1][0] / GRID_SIZE);
    const minY = Math.floor(slot.coordinates[0][1] / GRID_SIZE);
    const maxY = Math.ceil(slot.coordinates[2][1] / GRID_SIZE);

    for (let r = minY; r < maxY; r++) {
      for (let c = minX; c < maxX; c++) {
        if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
          grid[r][c] = isTarget ? 0 : 1;
        }
      }
    }
  });

  return grid;
}

/**
 * Executes A* algorithm between start and target slot.
 */
function findAStarPath(startPixel, goalPixel, targetSlot = null) {
  const grid = buildNavigationGrid(activeParkingSlots, targetSlot);

  const startGrid = {
    c: Math.min(Math.max(Math.floor(startPixel[0] / GRID_SIZE), 0), GRID_COLS - 1),
    r: Math.min(Math.max(Math.floor(startPixel[1] / GRID_SIZE), 0), GRID_ROWS - 1)
  };
  const goalGrid = {
    c: Math.min(Math.max(Math.floor(goalPixel[0] / GRID_SIZE), 0), GRID_COLS - 1),
    r: Math.min(Math.max(Math.floor(goalPixel[1] / GRID_SIZE), 0), GRID_ROWS - 1)
  };

  grid[startGrid.r][startGrid.c] = 0;
  grid[goalGrid.r][goalGrid.c] = 0;

  const heuristic = (c1, r1, c2, r2) => Math.hypot(c1 - c2, r1 - r2);
  const key = (c, r) => `${c},${r}`;

  const openSet = [];
  const openSetMap = new Map();
  const closedSet = new Set();
  const cameFrom = new Map();

  const gScore = new Map();
  const fScore = new Map();

  const startKey = key(startGrid.c, startGrid.r);
  gScore.set(startKey, 0);
  fScore.set(startKey, heuristic(startGrid.c, startGrid.r, goalGrid.c, goalGrid.r));

  openSet.push({ c: startGrid.c, r: startGrid.r, f: fScore.get(startKey) });
  openSetMap.set(startKey, true);

  const directions = [
    { dc: 0, dr: -1, cost: 1.0 },
    { dc: 0, dr: 1, cost: 1.0 },
    { dc: -1, dr: 0, cost: 1.0 },
    { dc: 1, dr: 0, cost: 1.0 },
    { dc: -1, dr: -1, cost: 1.414 },
    { dc: 1, dr: -1, cost: 1.414 },
    { dc: -1, dr: 1, cost: 1.414 },
    { dc: 1, dr: 1, cost: 1.414 }
  ];

  let current = null;

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    current = openSet.shift();
    const currKey = key(current.c, current.r);
    openSetMap.delete(currKey);

    if (current.c === goalGrid.c && current.r === goalGrid.r) {
      return reconstructPixelPath(cameFrom, current, startPixel, goalPixel);
    }

    closedSet.add(currKey);

    for (const dir of directions) {
      const nc = current.c + dir.dc;
      const nr = current.r + dir.dr;
      const neighborKey = key(nc, nr);

      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      if (grid[nr][nc] === 1) continue;
      if (closedSet.has(neighborKey)) continue;

      if (dir.dc !== 0 && dir.dr !== 0) {
        if (grid[current.r][nc] === 1 || grid[nr][current.c] === 1) continue;
      }

      const tentativeG = gScore.get(currKey) + dir.cost;
      const existingG = gScore.get(neighborKey) ?? Infinity;

      if (tentativeG < existingG) {
        cameFrom.set(neighborKey, { c: current.c, r: current.r });
        gScore.set(neighborKey, tentativeG);
        const f = tentativeG + heuristic(nc, nr, goalGrid.c, goalGrid.r);
        fScore.set(neighborKey, f);

        if (!openSetMap.has(neighborKey)) {
          openSet.push({ c: nc, r: nr, f });
          openSetMap.set(neighborKey, true);
        }
      }
    }
  }

  console.warn('A* path not found to goal');
  return [];
}

function reconstructPixelPath(cameFrom, current, startPixel, goalPixel) {
  const path = [];
  let curr = current;
  const key = (c, r) => `${c},${r}`;

  while (curr) {
    path.push([
      curr.c * GRID_SIZE + GRID_SIZE / 2,
      curr.r * GRID_SIZE + GRID_SIZE / 2
    ]);
    curr = cameFrom.get(key(curr.c, curr.r));
  }

  path.reverse();

  if (path.length > 0) {
    path[0] = [startPixel[0], startPixel[1]];
    path[path.length - 1] = [goalPixel[0], goalPixel[1]];
  }

  return simplifyPath(path);
}

function simplifyPath(points) {
  if (points.length <= 2) return points;
  const simplified = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dx1 = curr[0] - prev[0];
    const dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0];
    const dy2 = next[1] - curr[1];

    if (Math.abs(dx1 * dy2 - dy1 * dx2) > 0.01) {
      simplified.push(curr);
    }
  }

  simplified.push(points[points.length - 1]);
  return simplified;
}

// =========================================================================
// CANVAS RENDERING FUNCTIONS
// =========================================================================

function drawMapEnvironment() {
  if (!ctx || !canvas) return;

  // Clear map background
  ctx.fillStyle = '#0b111e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Background grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Driving lane dash lines
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 2;

  // Top corridor
  ctx.beginPath();
  ctx.moveTo(40, 175);
  ctx.lineTo(800, 175);
  ctx.stroke();

  // Bottom corridor
  ctx.beginPath();
  ctx.moveTo(40, 395);
  ctx.lineTo(800, 395);
  ctx.stroke();

  // Vertical center lane
  ctx.beginPath();
  ctx.moveTo(445, 30);
  ctx.lineTo(445, 560);
  ctx.stroke();
  ctx.restore();

  // Entry Gate Box (Positioned cleanly in bottom-left corner)
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(15, 548, 95, 34);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.strokeRect(15, 548, 95, 34);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ENTRY GATE', 62, 565);

  // Zone and Building Labels (Balanced & Non-overlapping with elevators and slots)
  drawZoneLabel('BUILDING A', 145, 30, '#06b6d4');
  drawZoneLabel('BUILDING B', 545, 30, '#3b82f6');
  drawZoneLabel('GUEST ZONE G', 430, 315, '#f59e0b');
  drawZoneLabel('BUILDING C', 145, 520, '#10b981');
  drawZoneLabel('BUILDING D', 545, 520, '#8b5cf6');

  // Draw Elevators & Obstacles
  drawElevators();
  drawObstacles();

  // Full Lot Watermark / Notice if full
  if (isParkingLotFull()) {
    drawFullLotNotice();
  }
}

function drawZoneLabel(name, x, y, color) {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x - 65, y - 14, 130, 24, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x, y - 2);
  ctx.restore();
}

function drawElevators() {
  if (!ctx) return;

  elevators.forEach((elv) => {
    ctx.save();
    const [x, y] = elv.position;

    ctx.fillStyle = 'rgba(14, 165, 233, 0.2)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - 36, y - 13, 72, 24, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e0f2fe';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🛗 ${elv.name}`, x, y);

    ctx.restore();
  });
}

function drawObstacles() {
  if (!ctx) return;

  fixedObstacles.forEach((obs) => {
    ctx.save();
    if (obs.type === 'pillar') {
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(obs.x, obs.y, obs.width, obs.height, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f97316';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(obs.label, obs.x + obs.width / 2, obs.y + obs.height / 2);
    } else if (obs.type === 'hazard') {
      ctx.fillStyle = 'rgba(234, 88, 12, 0.25)';
      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.roundRect(obs.x, obs.y, obs.width, obs.height, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fb923c';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚧', obs.x + obs.width / 2, obs.y + obs.height / 2);
    }
    ctx.restore();
  });
}

function drawFullLotNotice() {
  ctx.save();
  ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(canvas.width / 2 - 160, canvas.height / 2 - 28, 320, 56, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f87171';
  ctx.font = 'bold 15px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚠️ PARKING LOT 100% FULL', canvas.width / 2, canvas.height / 2 - 8);

  ctx.font = '11px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = '#fca5a5';
  ctx.fillText('No available bays. Entry barrier locked.', canvas.width / 2, canvas.height / 2 + 12);
  ctx.restore();
}

// Interactive Selection State
let hoveredSlot = null;
let selectedSlot = null;
let currentDrawnPath = null;
let currentWalkingInfo = null;

// DOM Inspector Elements
let bayInspectorPopover = null;
let popoverBayId = null;
let popoverBayZone = null;
let popoverBayBadge = null;
let popoverBayPlate = null;
let popoverToggleBtn = null;
let popoverCloseBtn = null;

/**
 * Finds a parking slot under the given pixel coordinate.
 */
function getSlotAtPixel(px, py) {
  return activeParkingSlots.find((slot) => {
    const minX = slot.coordinates[0][0];
    const maxX = slot.coordinates[1][0];
    const minY = slot.coordinates[0][1];
    const maxY = slot.coordinates[2][1];
    return px >= minX && px <= maxX && py >= minY && py <= maxY;
  }) || null;
}

/**
 * Converts mouse event coordinates to canvas resolution space (840x620).
 */
function getCanvasCoords(event) {
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

/**
 * Draws all 30 parking slots supporting FREE, OCCUPIED, and RESERVED states with interactive highlights.
 */
function drawSlots(slots = activeParkingSlots) {
  if (!ctx) return;

  slots.forEach((slot) => {
    ctx.save();
    ctx.beginPath();

    const coords = slot.coordinates;
    ctx.moveTo(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
      ctx.lineTo(coords[i][0], coords[i][1]);
    }
    ctx.closePath();

    const isHovered = (hoveredSlot && hoveredSlot.id === slot.id);
    const isSelected = (selectedSlot && selectedSlot.id === slot.id);

    if (slot.isReserved) {
      // Amber/Gold for RESERVED
      ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.strokeStyle = isSelected ? '#fef08a' : isHovered ? '#fbbf24' : '#f59e0b';
      ctx.lineWidth = isSelected ? 3.5 : isHovered ? 3 : 2.5;
      ctx.shadowColor = 'rgba(245, 158, 11, 0.6)';
      ctx.shadowBlur = isHovered || isSelected ? 12 : 8;
    } else if (slot.occupied) {
      // Red for OCCUPIED
      ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.strokeStyle = isSelected ? '#fef08a' : isHovered ? '#fca5a5' : '#ef4444';
      ctx.lineWidth = isSelected ? 3.5 : isHovered ? 3 : 2;
      ctx.shadowColor = isHovered || isSelected ? 'rgba(239, 68, 68, 0.6)' : 'transparent';
      ctx.shadowBlur = isHovered || isSelected ? 10 : 0;
    } else {
      // Green for FREE
      ctx.fillStyle = isHovered ? 'rgba(34, 197, 94, 0.42)' : 'rgba(34, 197, 94, 0.28)';
      ctx.strokeStyle = isSelected ? '#fef08a' : isHovered ? '#86efac' : '#22c55e';
      ctx.lineWidth = isSelected ? 3.5 : isHovered ? 3 : 2;
      ctx.shadowColor = isHovered || isSelected ? 'rgba(34, 197, 94, 0.6)' : 'transparent';
      ctx.shadowBlur = isHovered || isSelected ? 10 : 0;
    }

    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Slot ID Label
    ctx.fillStyle = slot.isReserved ? '#fde68a' : slot.occupied ? '#fca5a5' : '#86efac';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slot.id, slot.center[0], slot.center[1] - 6);

    // Status label
    ctx.font = '8px "Plus Jakarta Sans", sans-serif';
    if (slot.isReserved) {
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('RESERVED', slot.center[0], slot.center[1] + 9);
    } else if (slot.occupied) {
      ctx.fillStyle = '#f87171';
      ctx.fillText('OCCUPIED', slot.center[0], slot.center[1] + 9);
    } else {
      ctx.fillStyle = '#4ade80';
      ctx.fillText('FREE', slot.center[0], slot.center[1] + 9);
    }

    // Outer subtle focus outline on hover
    if (isHovered && !isSelected) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(slot.coordinates[0][0] - 2, slot.coordinates[0][1] - 2, slot.width + 4, slot.height + 4);
    }

    ctx.restore();
  });
}

/**
 * Draws the vehicular path and pedestrian walking line on top of map.
 */
function drawPathOnly(pathCoords, walkingInfo = null) {
  if (!ctx || !pathCoords || pathCoords.length < 2) return;

  ctx.save();

  // 1. Vehicular A* Path
  ctx.beginPath();
  ctx.moveTo(pathCoords[0][0], pathCoords[0][1]);
  for (let i = 1; i < pathCoords.length; i++) {
    ctx.lineTo(pathCoords[i][0], pathCoords[i][1]);
  }

  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 5.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(250, 204, 21, 0.8)';
  ctx.shadowBlur = 10;
  ctx.stroke();

  // Start circle
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(pathCoords[0][0], pathCoords[0][1], 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // End circle
  const lastPoint = pathCoords[pathCoords.length - 1];
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(lastPoint[0], lastPoint[1], 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 2. Pedestrian Walking Path to Elevator
  if (walkingInfo && walkingInfo.elevatorPos) {
    const [ex, ey] = walkingInfo.elevatorPos;
    const [sx, sy] = lastPoint;

    ctx.beginPath();
    ctx.setLineDash([5, 5]);
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(56, 189, 248, 0.7)';
    ctx.shadowBlur = 8;
    ctx.stroke();

    let midX = (sx + ex) / 2;
    let midY = (sy + ey) / 2;

    // Shift pedestrian badge if too close to any pillar
    fixedObstacles.forEach((obs) => {
      if (Math.hypot(midX - (obs.x + obs.width / 2), midY - (obs.y + obs.height / 2)) < 36) {
        midX += (midX < 420 ? 38 : -38);
      }
    });

    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - 35, midY - 12, 70, 22, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🚶 ~${walkingInfo.distanceMeters}m`, midX, midY);
  }

  ctx.restore();
}

// Active Car Animation Handle
let carAnimationId = null;

/**
 * Animates a vehicle sprite moving along the A* polyline path to the bay.
 */
function animateCarAlongRoute(pathCoords, walkingInfo, targetSlotId, onComplete = null) {
  if (!ctx || !pathCoords || pathCoords.length < 2) {
    drawRoutingPath(pathCoords, walkingInfo);
    if (onComplete) onComplete();
    return;
  }

  if (carAnimationId) {
    cancelAnimationFrame(carAnimationId);
    carAnimationId = null;
  }

  // Precompute segment lengths and total distance
  const segments = [];
  let totalDistance = 0;
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const p1 = pathCoords[i];
    const p2 = pathCoords[i + 1];
    const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    segments.push({ p1, p2, dist });
    totalDistance += dist;
  }

  currentDrawnPath = pathCoords;
  currentWalkingInfo = walkingInfo;

  const durationMs = 1750; // Smooth 1.75s travel
  const startTime = performance.now();

  function drawVehicleSprite(x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Headlight cones projecting forward
    ctx.fillStyle = 'rgba(254, 240, 138, 0.25)';
    ctx.beginPath();
    ctx.moveTo(14, -6);
    ctx.lineTo(44, -16);
    ctx.lineTo(44, 16);
    ctx.lineTo(14, 6);
    ctx.closePath();
    ctx.fill();

    // Car Body (Sports Coupe with neon glow)
    ctx.shadowColor = 'rgba(56, 189, 248, 0.8)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#0284c7';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-13, -7, 26, 14, 3);
    ctx.fill();
    ctx.stroke();

    // Windshield
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.roundRect(-4, -5, 10, 10, 2);
    ctx.fill();

    // Headlight bulbs
    ctx.fillStyle = '#fef08a';
    ctx.fillRect(11, -6, 2, 3);
    ctx.fillRect(11, 3, 2, 3);

    // Tail lights
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-13, -6, 2, 3);
    ctx.fillRect(-13, 3, 2, 3);

    ctx.restore();
  }

  function frame(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1.0);

    // Smooth cubic ease-in-out
    const easeProgress = progress < 0.5 
      ? 2 * progress * progress 
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    const currentDist = easeProgress * totalDistance;

    let accumulated = 0;
    let carX = pathCoords[0][0];
    let carY = pathCoords[0][1];
    let carAngle = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (accumulated + seg.dist >= currentDist || i === segments.length - 1) {
        const segDist = currentDist - accumulated;
        const t = seg.dist > 0 ? Math.min(Math.max(segDist / seg.dist, 0), 1) : 1;
        carX = seg.p1[0] + (seg.p2[0] - seg.p1[0]) * t;
        carY = seg.p1[1] + (seg.p2[1] - seg.p1[1]) * t;
        carAngle = Math.atan2(seg.p2[1] - seg.p1[1], seg.p2[0] - seg.p1[0]);
        break;
      }
      accumulated += seg.dist;
    }

    // Redraw map baseline
    drawMapEnvironment();
    drawSlots(activeParkingSlots);
    drawPathOnly(pathCoords, null); // Hide walking route until vehicle parks

    // Draw the moving vehicle
    drawVehicleSprite(carX, carY, carAngle);

    if (progress < 1.0) {
      carAnimationId = requestAnimationFrame(frame);
    } else {
      carAnimationId = null;

      // Arrival: transition target slot to OCCUPIED
      const targetSlot = activeParkingSlots.find((s) => s.id === targetSlotId);
      if (targetSlot) {
        targetSlot.isReserved = false;
        targetSlot.occupied = true;
      }

      // Redraw map with walking line to elevator
      redrawCurrentMap();

      if (onComplete) {
        onComplete();
      }
    }
  }

  carAnimationId = requestAnimationFrame(frame);
}

/**
 * Saves and draws the active routing path statically.
 */
function drawRoutingPath(pathCoords, walkingInfo = null) {
  if (carAnimationId) {
    cancelAnimationFrame(carAnimationId);
    carAnimationId = null;
  }
  currentDrawnPath = pathCoords;
  currentWalkingInfo = walkingInfo;
  redrawCurrentMap();
}

/**
 * Redraws current map including active route if present.
 */
function redrawCurrentMap() {
  if (!ctx || !canvas) return;
  drawMapEnvironment();
  drawSlots(activeParkingSlots);
  if (currentDrawnPath && currentDrawnPath.length >= 2) {
    drawPathOnly(currentDrawnPath, currentWalkingInfo);
  }
}

/**
 * Resets path and redraws baseline map.
 */
function initParkingMap() {
  if (carAnimationId) {
    cancelAnimationFrame(carAnimationId);
    carAnimationId = null;
  }
  if (!ctx || !canvas) return;
  currentDrawnPath = null;
  currentWalkingInfo = null;
  selectedSlot = null;
  hideBayInspector();
  redrawCurrentMap();
}

/**
 * Displays floating bay inspector popover.
 */
function showBayInspector(slot) {
  if (!bayInspectorPopover || !canvas) return;

  popoverBayId.textContent = `Bay ${slot.id}`;
  popoverBayZone.textContent = slot.zoneName || `Zone ${slot.zone}`;

  if (slot.isReserved) {
    popoverBayBadge.textContent = 'RESERVED';
    popoverBayBadge.className = 'badge badge-guest';
    popoverBayBadge.style.background = '';
    popoverBayBadge.style.color = '';
    popoverBayPlate.textContent = slot.reservedPlate || 'Assigned';
    popoverToggleBtn.textContent = '🚪 Release Bay (Check-Out)';
    popoverToggleBtn.className = 'btn btn-sm btn-danger';
  } else if (slot.occupied) {
    popoverBayBadge.textContent = 'OCCUPIED';
    popoverBayBadge.className = 'badge';
    popoverBayBadge.style.background = 'rgba(239, 68, 68, 0.2)';
    popoverBayBadge.style.color = '#f87171';
    popoverBayPlate.textContent = slot.parkedPlate || slot.reservedPlate || 'Parked Vehicle';
    popoverToggleBtn.textContent = '🚪 Release Bay (Check-Out)';
    popoverToggleBtn.className = 'btn btn-sm btn-danger';
  } else {
    popoverBayBadge.textContent = 'FREE';
    popoverBayBadge.className = 'badge';
    popoverBayBadge.style.background = 'rgba(34, 197, 94, 0.2)';
    popoverBayBadge.style.color = '#86efac';
    popoverBayPlate.textContent = 'None';
    popoverToggleBtn.textContent = '🚗 Park Vehicle Here';
    popoverToggleBtn.className = 'btn btn-sm btn-success';
  }

  // Position relative to canvasWrapper
  const wrapper = document.getElementById('canvasWrapper');
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : canvas.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const slotScreenX = (slot.center[0] / canvas.width) * canvasRect.width + (canvasRect.left - wrapperRect.left);
  const slotScreenY = (slot.center[1] / canvas.height) * canvasRect.height + (canvasRect.top - wrapperRect.top);

  let popoverX = slotScreenX + 25;
  let popoverY = slotScreenY - 60;

  if (popoverX + 260 > wrapperRect.width) {
    popoverX = slotScreenX - 275;
  }
  if (popoverY < 10) popoverY = 10;

  bayInspectorPopover.style.left = `${Math.max(10, Math.round(popoverX))}px`;
  bayInspectorPopover.style.top = `${Math.max(10, Math.round(popoverY))}px`;
  bayInspectorPopover.classList.remove('hidden');
}

/**
 * Hides floating bay inspector.
 */
function hideBayInspector() {
  if (bayInspectorPopover) {
    bayInspectorPopover.classList.add('hidden');
  }
}

/**
 * Loads campus map configuration schema dynamically.
 */
function loadParkingMapConfig(config) {
  if (!config) return false;
  try {
    if (config.gate && Array.isArray(config.gate.position)) {
      GATE_POSITION[0] = config.gate.position[0];
      GATE_POSITION[1] = config.gate.position[1];
    }
    if (Array.isArray(config.elevators) && config.elevators.length > 0) {
      elevators = config.elevators.map((e) => ({ ...e }));
    }
    if (Array.isArray(config.obstacles) && config.obstacles.length > 0) {
      fixedObstacles = config.obstacles.map((o) => ({ ...o }));
    }
    if (Array.isArray(config.zones) && config.zones.length > 0) {
      defaultCampusZones = config.zones.map((z) => ({ ...z }));
      activeParkingSlots = buildCampusSlots(defaultCampusZones);
    }
    initParkingMap();
    console.log('[CampusManager] Successfully applied parking campus configuration:', config.campus_name || 'Custom Campus');
    return true;
  } catch (err) {
    console.error('[CampusManager] Error loading map configuration:', err);
    return false;
  }
}

// Global exports
window.parkingCanvas = {
  canvas,
  ctx,
  GATE_POSITION,
  getElevators: () => elevators,
  getObstacles: () => fixedObstacles,
  getActiveSlots: () => activeParkingSlots,
  loadParkingMapConfig,
  updateSlotOccupancy,
  reserveSlot,
  releaseSlot,
  occupySlot,
  freeAllBays,
  getSlotAtPixel,
  isParkingLotFull,
  getParkingStats,
  assignOptimalParkingSlot,
  findAStarPath,
  drawSlots,
  drawRoutingPath,
  animateCarAlongRoute,
  drawMapEnvironment,
  redrawCurrentMap,
  initParkingMap,
  showBayInspector,
  hideBayInspector
};

window.assignOptimalParkingSlot = assignOptimalParkingSlot;
window.reserveSlot = reserveSlot;
window.releaseSlot = releaseSlot;
window.occupySlot = occupySlot;
window.freeAllBays = freeAllBays;
window.findAStarPath = findAStarPath;
window.drawRoutingPath = drawRoutingPath;
window.animateCarAlongRoute = animateCarAlongRoute;
window.loadParkingMapConfig = loadParkingMapConfig;

// Setup interactive canvas events
document.addEventListener('DOMContentLoaded', () => {
  bayInspectorPopover = document.getElementById('bayInspectorPopover');
  popoverBayId = document.getElementById('popoverBayId');
  popoverBayZone = document.getElementById('popoverBayZone');
  popoverBayBadge = document.getElementById('popoverBayBadge');
  popoverBayPlate = document.getElementById('popoverBayPlate');
  popoverToggleBtn = document.getElementById('popoverToggleBtn');
  popoverCloseBtn = document.getElementById('popoverCloseBtn');

  if (canvas) {
    canvas.addEventListener('mousemove', (e) => {
      const { x, y } = getCanvasCoords(e);
      const slot = getSlotAtPixel(x, y);
      if (slot !== hoveredSlot) {
        hoveredSlot = slot;
        canvas.style.cursor = slot ? 'pointer' : 'default';
        redrawCurrentMap();
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoveredSlot) {
        hoveredSlot = null;
        canvas.style.cursor = 'default';
        redrawCurrentMap();
      }
    });

    canvas.addEventListener('click', (e) => {
      const { x, y } = getCanvasCoords(e);
      const slot = getSlotAtPixel(x, y);
      if (slot) {
        selectedSlot = slot;
        redrawCurrentMap();
        showBayInspector(slot);
      } else {
        selectedSlot = null;
        redrawCurrentMap();
        hideBayInspector();
      }
    });
  }

  if (popoverCloseBtn) {
    popoverCloseBtn.addEventListener('click', () => {
      selectedSlot = null;
      hideBayInspector();
      redrawCurrentMap();
    });
  }

  if (popoverToggleBtn) {
    popoverToggleBtn.addEventListener('click', () => {
      if (!selectedSlot) return;
      const targetSlot = selectedSlot;
      if (targetSlot.occupied || targetSlot.isReserved) {
        releaseSlot(targetSlot.id);
        if (typeof window.onSlotReleased === 'function') {
          window.onSlotReleased(targetSlot.id);
        }
      } else {
        occupySlot(targetSlot.id, 'MANUAL-PARK');
        if (typeof window.onSlotOccupied === 'function') {
          window.onSlotOccupied(targetSlot.id);
        }
      }
      showBayInspector(targetSlot);
    });
  }

  initParkingMap();
});
