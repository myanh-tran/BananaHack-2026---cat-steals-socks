/**
 * js/main.js
 * Handles OCR API logic, user interactions, and UI event listeners.
 */

// DOM Elements
const guestModal = document.getElementById('guestModal');
const destinationSelect = document.getElementById('destinationSelect');
const findParkingBtn = document.getElementById('findParkingBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const simulateEntryBtn = document.getElementById('simulateEntryBtn');
const clearRouteBtn = document.getElementById('clearRouteBtn');

// OCR and Status UI elements
const ocrPlateDisplay = document.getElementById('ocrPlateDisplay');
const ocrStatusBadge = document.getElementById('ocrStatusBadge');
const ocrBuildingDisplay = document.getElementById('ocrBuildingDisplay');
const routeInfoDisplay = document.getElementById('routeInfoDisplay');

/**
 * Mock function simulating an API response from the OCR gate camera module.
 * @returns {Promise<Object>} Mock OCR payload
 */
function checkGateEntry() {
  console.log('Scanning vehicle at gate camera...');

  // Mock API payload returned from OCR module
  const mockApiResponse = {
    status: 'SUCCESS',
    licensePlate: '29A-982.46',
    vehicleType: 'Car (Sedan)',
    building: 'guest', // Indicates non-resident visitor requiring destination selection
    timestamp: new Date().toLocaleTimeString()
  };

  // Update UI with scanned plate information
  if (ocrPlateDisplay) {
    ocrPlateDisplay.textContent = mockApiResponse.licensePlate;
  }
  if (ocrStatusBadge) {
    ocrStatusBadge.textContent = 'GUEST VISITOR';
    ocrStatusBadge.className = 'badge badge-guest';
  }
  if (ocrBuildingDisplay) {
    ocrBuildingDisplay.textContent = 'Awaiting Selection...';
  }

  // DOM Logic: If vehicle is a "guest", display the destination modal
  if (mockApiResponse.building === 'guest') {
    showGuestModal();
  }

  return Promise.resolve(mockApiResponse);
}

/**
 * Display the guest destination modal
 */
function showGuestModal() {
  if (guestModal) {
    guestModal.classList.remove('hidden');
    guestModal.classList.add('show');
  }
}

/**
 * Hide the guest destination modal
 */
function hideGuestModal() {
  if (guestModal) {
    guestModal.classList.remove('show');
    guestModal.classList.add('hidden');
  }
}

/**
 * Mock function to calculate and fetch A* route coordinates based on building destination.
 * Passes hardcoded dummy [x, y] coordinates to drawRoutingPath() in canvas.js.
 * @param {string} building - Selected destination building (e.g. "Building A")
 */
function fetchParkingRoute(building) {
  console.log(`Calculating A* route for destination: ${building}`);

  // Hardcoded sets of [x, y] coordinates connecting Entry Gate [85, 480] to slots
  const mockRoutes = {
    'Building A': [
      [85, 480],
      [85, 215],
      [230, 215],
      [230, 165]
    ],
    'Building B': [
      [85, 480],
      [85, 215],
      [450, 215],
      [590, 215],
      [590, 165]
    ],
    'Building C': [
      [85, 480],
      [85, 395],
      [310, 395],
      [310, 345]
    ],
    'Building D': [
      [85, 480],
      [85, 395],
      [510, 395],
      [510, 345]
    ]
  };

  // Target slot recommendations
  const slotRecommendations = {
    'Building A': 'A-02 (Level 1, North)',
    'Building B': 'B-02 (Level 1, East)',
    'Building C': 'C-03 (Level 1, South-West)',
    'Building D': 'D-01 (Level 1, South-East)'
  };

  const selectedRoute = mockRoutes[building] || mockRoutes['Building A'];
  const recommendedSlot = slotRecommendations[building] || 'A-02';

  // Update UI Status
  if (ocrBuildingDisplay) {
    ocrBuildingDisplay.textContent = building;
  }
  if (routeInfoDisplay) {
    routeInfoDisplay.textContent = `Routing to ${recommendedSlot} via optimal A* path`;
  }

  // Draw the route on the 2D canvas using function in canvas.js
  if (typeof drawRoutingPath === 'function') {
    drawRoutingPath(selectedRoute);
  } else if (window.parkingCanvas && typeof window.parkingCanvas.drawRoutingPath === 'function') {
    window.parkingCanvas.drawRoutingPath(selectedRoute);
  } else {
    console.warn('drawRoutingPath function not found.');
  }
}

// Event Listeners setup
document.addEventListener('DOMContentLoaded', () => {
  // Find Parking Button in Guest Modal
  if (findParkingBtn) {
    findParkingBtn.addEventListener('click', () => {
      const selectedBuilding = destinationSelect ? destinationSelect.value : 'Building A';
      hideGuestModal();
      fetchParkingRoute(selectedBuilding);
    });
  }

  // Optional Close/Cancel Modal button
  if (cancelModalBtn) {
    cancelModalBtn.addEventListener('click', () => {
      hideGuestModal();
    });
  }

  // Gate simulation button
  if (simulateEntryBtn) {
    simulateEntryBtn.addEventListener('click', () => {
      checkGateEntry();
    });
  }

  // Reset route button
  if (clearRouteBtn) {
    clearRouteBtn.addEventListener('click', () => {
      if (window.parkingCanvas && typeof window.parkingCanvas.initParkingMap === 'function') {
        window.parkingCanvas.initParkingMap();
      }
      if (routeInfoDisplay) {
        routeInfoDisplay.textContent = 'None (Waiting for gate entry)';
      }
    });
  }

  // Automatically trigger simulated OCR scan once shortly after launch for immediate demo
  setTimeout(() => {
    checkGateEntry();
  }, 600);
});

// Expose functions globally for testing and script access
window.checkGateEntry = checkGateEntry;
window.fetchParkingRoute = fetchParkingRoute;
window.showGuestModal = showGuestModal;
window.hideGuestModal = hideGuestModal;
