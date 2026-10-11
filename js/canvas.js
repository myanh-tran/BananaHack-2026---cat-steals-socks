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
let GATE_POSITION = [70, 520];

// Fixed Building Elevators
let elevators = [
  { id: 'ELV-A', name: 'Elevator A', zone: 'A', position: [240, 68] },
  { id: 'ELV-B', name: 'Elevator B', zone: 'B', position: [640, 68] },
  { id: 'ELV-C', name: 'Elevator C', zone: 'C', position: [240, 435] },
  { id: 'ELV-D', name: 'Elevator D', zone: 'D', position: [640, 435] }
];

// Fixed Obstacles (Structural Pillars & Maintenance)
let fixedObstacles = [
  { id: 'PIL-1', type: 'pillar', x: 235, y: 175, width: 20, height: 20, label: 'P1' },
  { id: 'PIL-2', type: 'pillar', x: 635, y: 175, width: 20, height: 20, label: 'P2' },
  { id: 'PIL-3', type: 'pillar', x: 235, y: 360, width: 20, height: 20, label: 'P3' },
  { id: 'PIL-4', type: 'pillar', x: 635, y: 360, width: 20, height: 20, label: 'P4' },
  { id: 'HAZ-1', type: 'hazard', x: 430, y: 260, width: 30, height: 30, label: '🚧' }
];

// Campus Zone Blueprint definition (30 Slots Total)
let defaultCampusZones = [
  {
    name: 'Building A',
    prefix: 'A',
    type: 'resident',
    count: 6,
    startX: 85,
    startY: 75,
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
    startY: 75,
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
    startY: 235,
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
    startY: 435,
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
    startY: 435,
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
    initParkingMap();
    return true;
  }
  return false;
}

/**
 * Releases a reserved slot back to free state if cancelled.
 */
function releaseSlot(slotId) {
  const target = activeParkingSlots.find((s) => s.id === slotId);
  if (target) {
    target.isReserved = false;
    target.occupied = false;
    target.reservedPlate = null;
    initParkingMap();
  }
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
      message: 'Toàn bộ bãi đỗ xe đã kín 100% (0/30 chỗ trống).'
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
        message: `Đã cấp ô ${residentFreeSlots[0].slot.id} (Tòa ${building}) - cách thang máy ~${residentFreeSlots[0].distanceMeters}m.`
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
        message: `Tòa ${building} đã đầy! Đã điều phối sang ô ${best.slot.id} (cách thang máy Tòa ${building} ~${best.distanceMeters}m).`
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
        message: `Đã cấp ô khách ${best.slot.id} (Khu G) - cách thang máy ${targetElevator.name} ~${best.distanceMeters}m.`
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
        message: `Khu khách G đã đầy! Đã điều phối sang ô ${best.slot.id} (Tòa ${best.slot.zone}) - cách thang máy ${targetElevator.name} ~${best.distanceMeters}m.`
      };
    }
  }

  return { status: 'FULL', slot: null, message: 'Bãi đỗ xe đã kín chỗ.' };
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
    const inTopCorridor = py >= 135 && py <= 225; // Continuous access to Zone A, Zone B and top of Zone G
    const inMiddleCorridor = py >= 295 && py <= 370; // Access to Zone G and bypass lane
    const inBottomCorridor = py >= 360 && py <= 445; // Continuous access to Zone C & Zone D
    const inGateLane = py >= 490 && py <= 560 && px <= 460; // Gate entrance lane

    // Vertical lanes (connecting all corridors)
    const inLeftLane = px >= 35 && px <= 95 && py >= 135 && py <= 560;
    const inCenterLane = px >= 415 && px <= 475 && py >= 135 && py <= 560;
    const inRightLane = px >= 755 && px <= 810 && py >= 135 && py <= 560;

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
  ctx.moveTo(40, 190);
  ctx.lineTo(800, 190);
  ctx.stroke();

  // Bottom corridor
  ctx.beginPath();
  ctx.moveTo(40, 395);
  ctx.lineTo(800, 395);
  ctx.stroke();

  // Vertical center lane
  ctx.beginPath();
  ctx.moveTo(445, 40);
  ctx.lineTo(445, 520);
  ctx.stroke();
  ctx.restore();

  // Entry Gate Box
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(20, 500, 100, 40);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 500, 100, 40);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ENTRY GATE', 70, 524);

  // Zone and Building Labels
  drawZoneLabel('BUILDING A', 225, 36, '#06b6d4');
  drawZoneLabel('BUILDING B', 625, 36, '#3b82f6');
  drawZoneLabel('GUEST ZONE G', 425, 320, '#f59e0b');
  drawZoneLabel('BUILDING C', 225, 545, '#10b981');
  drawZoneLabel('BUILDING D', 625, 545, '#8b5cf6');

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

/**
 * Draws all 30 parking slots supporting FREE, OCCUPIED, and RESERVED states.
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

    if (slot.isReserved) {
      // Amber/Gold for RESERVED
      ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(245, 158, 11, 0.5)';
      ctx.shadowBlur = 8;
    } else if (slot.occupied) {
      // Red for OCCUPIED
      ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
    } else {
      // Green for FREE
      ctx.fillStyle = 'rgba(34, 197, 94, 0.28)';
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
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

    ctx.restore();
  });
}

/**
 * Draws the routing paths:
 * 1. Vehicle A* path (Yellow glowing stroke)
 * 2. Pedestrian Walking path (Dotted cyan stroke)
 */
function drawRoutingPath(pathCoords, walkingInfo = null) {
  if (!ctx || !pathCoords || pathCoords.length < 2) return;

  drawMapEnvironment();
  drawSlots(activeParkingSlots);

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

    const midX = (sx + ex) / 2;
    const midY = (sy + ey) / 2;
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

/**
 * Initializes/Redraws the map.
 */
function initParkingMap() {
  if (!ctx || !canvas) return;
  drawMapEnvironment();
  drawSlots(activeParkingSlots);
}

/**
 * Loads campus map configuration schema dynamically (from parking_map.json or admin upload).
 * @param {Object} config - Blueprint JSON schema
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
  isParkingLotFull,
  getParkingStats,
  assignOptimalParkingSlot,
  findAStarPath,
  drawSlots,
  drawRoutingPath,
  drawMapEnvironment,
  initParkingMap
};

window.assignOptimalParkingSlot = assignOptimalParkingSlot;
window.reserveSlot = reserveSlot;
window.findAStarPath = findAStarPath;
window.drawRoutingPath = drawRoutingPath;
window.loadParkingMapConfig = loadParkingMapConfig;

document.addEventListener('DOMContentLoaded', () => {
  initParkingMap();
});
