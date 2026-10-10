/**
 * js/canvas.js
 * Strictly for drawing the 2D parking lot map and routing visualization.
 */

// Initialize Canvas and 2D Context
const canvas = document.getElementById('parkingMap');
const ctx = canvas ? canvas.getContext('2d') : null;

// Dummy JSON array of parking slots
const dummyParkingSlots = [
  // Zone A (Near Building A)
  {
    id: 'A-01',
    coordinates: [[120, 90], [180, 90], [180, 160], [120, 160]],
    occupied: true,
    zone: 'Building A'
  },
  {
    id: 'A-02',
    coordinates: [[200, 90], [260, 90], [260, 160], [200, 160]],
    occupied: false,
    zone: 'Building A'
  },
  {
    id: 'A-03',
    coordinates: [[280, 90], [340, 90], [340, 160], [280, 160]],
    occupied: false,
    zone: 'Building A'
  },
  {
    id: 'A-04',
    coordinates: [[360, 90], [420, 90], [420, 160], [360, 160]],
    occupied: true,
    zone: 'Building A'
  },

  // Zone B (Near Building B)
  {
    id: 'B-01',
    coordinates: [[480, 90], [540, 90], [540, 160], [480, 160]],
    occupied: true,
    zone: 'Building B'
  },
  {
    id: 'B-02',
    coordinates: [[560, 90], [620, 90], [620, 160], [560, 160]],
    occupied: false,
    zone: 'Building B'
  },
  {
    id: 'B-03',
    coordinates: [[640, 90], [700, 90], [700, 160], [640, 160]],
    occupied: true,
    zone: 'Building B'
  },

  // Zone C (Near Building C)
  {
    id: 'C-01',
    coordinates: [[120, 270], [180, 270], [180, 340], [120, 340]],
    occupied: true,
    zone: 'Building C'
  },
  {
    id: 'C-02',
    coordinates: [[200, 270], [260, 270], [260, 340], [200, 340]],
    occupied: true,
    zone: 'Building C'
  },
  {
    id: 'C-03',
    coordinates: [[280, 270], [340, 270], [340, 340], [280, 340]],
    occupied: false,
    zone: 'Building C'
  },
  {
    id: 'C-04',
    coordinates: [[360, 270], [420, 270], [420, 340], [360, 340]],
    occupied: false,
    zone: 'Building C'
  },

  // Zone D (Near Building D)
  {
    id: 'D-01',
    coordinates: [[480, 270], [540, 270], [540, 340], [480, 340]],
    occupied: false,
    zone: 'Building D'
  },
  {
    id: 'D-02',
    coordinates: [[560, 270], [620, 270], [620, 340], [560, 340]],
    occupied: true,
    zone: 'Building D'
  },
  {
    id: 'D-03',
    coordinates: [[640, 270], [700, 270], [700, 340], [640, 340]],
    occupied: false,
    zone: 'Building D'
  }
];

// Map layout static elements (road markings, buildings, gate)
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

  // Draw Driving Lanes
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 2;

  // Horizontal driving corridors
  ctx.beginPath();
  ctx.moveTo(50, 215);
  ctx.lineTo(750, 215);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(50, 395);
  ctx.lineTo(750, 395);
  ctx.stroke();

  // Vertical driving lane
  ctx.beginPath();
  ctx.moveTo(450, 50);
  ctx.lineTo(450, 500);
  ctx.stroke();
  ctx.restore();

  // Draw Gate (Entrance) at bottom-left
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(30, 480, 110, 40);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 480, 110, 40);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 12px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ENTRY GATE', 85, 505);

  // Buildings indicators
  drawBuildingLabel('BUILDING A', 270, 40, '#06b6d4');
  drawBuildingLabel('BUILDING B', 590, 40, '#3b82f6');
  drawBuildingLabel('BUILDING C', 270, 460, '#10b981');
  drawBuildingLabel('BUILDING D', 590, 460, '#8b5cf6');
}

function drawBuildingLabel(name, x, y, color) {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x - 70, y - 18, 140, 28, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 12px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x, y - 4);
  ctx.restore();
}

/**
 * Draws parking slots from an array of slot objects.
 * Green for free slots, Red for occupied slots.
 * @param {Array} slots - Array of slot objects with id, coordinates, and occupied status
 */
function drawSlots(slots = dummyParkingSlots) {
  if (!ctx) return;

  slots.forEach((slot) => {
    ctx.save();
    ctx.beginPath();

    const coords = slot.coordinates;
    if (Array.isArray(coords) && coords.length >= 3) {
      // Polygon vertices
      ctx.moveTo(coords[0][0], coords[0][1]);
      for (let i = 1; i < coords.length; i++) {
        ctx.lineTo(coords[i][0], coords[i][1]);
      }
      ctx.closePath();
    } else if (Array.isArray(coords) && coords.length === 4 && typeof coords[0] === 'number') {
      // [x, y, width, height] format
      ctx.rect(coords[0], coords[1], coords[2], coords[3]);
    }

    if (slot.occupied) {
      // Red for occupied
      ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
    } else {
      // Green for free
      ctx.fillStyle = 'rgba(34, 197, 94, 0.28)';
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
    }

    ctx.fill();
    ctx.stroke();

    // Calculate center for slot ID label
    let centerX = 0;
    let centerY = 0;
    if (Array.isArray(coords) && coords.length >= 3) {
      coords.forEach(pt => {
        centerX += pt[0];
        centerY += pt[1];
      });
      centerX /= coords.length;
      centerY /= coords.length;
    }

    // Draw slot ID label
    ctx.fillStyle = slot.occupied ? '#fca5a5' : '#86efac';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slot.id, centerX, centerY - 6);

    // Status text
    ctx.font = '9px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = slot.occupied ? '#f87171' : '#4ade80';
    ctx.fillText(slot.occupied ? 'OCCUPIED' : 'FREE', centerX, centerY + 10);

    ctx.restore();
  });
}

/**
 * Accepts an array of [x, y] coordinates and draws a thick yellow stroke
 * connecting points to visualize the A* algorithm path.
 * @param {Array<Array<number>>} pathCoords - Array of [x, y] coordinates
 */
function drawRoutingPath(pathCoords) {
  if (!ctx || !pathCoords || pathCoords.length < 2) return;

  // Redraw environment and slots to refresh previous routes
  drawMapEnvironment();
  drawSlots(dummyParkingSlots);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pathCoords[0][0], pathCoords[0][1]);

  for (let i = 1; i < pathCoords.length; i++) {
    ctx.lineTo(pathCoords[i][0], pathCoords[i][1]);
  }

  // Thick yellow stroke with subtle glow for dark-mode hackathon aesthetic
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(250, 204, 21, 0.7)';
  ctx.shadowBlur = 10;
  ctx.stroke();

  // Draw start circle (Entry Gate)
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(pathCoords[0][0], pathCoords[0][1], 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw destination pin/circle (Target Slot)
  const lastPoint = pathCoords[pathCoords.length - 1];
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(lastPoint[0], lastPoint[1], 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

/**
 * Initialize 2D Parking Map
 */
function initParkingMap() {
  if (!ctx || !canvas) return;
  drawMapEnvironment();
  drawSlots(dummyParkingSlots);
}

// Make functions accessible globally for main.js and scripts
window.parkingCanvas = {
  canvas,
  ctx,
  dummyParkingSlots,
  drawSlots,
  drawRoutingPath,
  drawMapEnvironment,
  initParkingMap
};

// Auto-render on load
document.addEventListener('DOMContentLoaded', () => {
  initParkingMap();
});
