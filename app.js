const RETURN_PERIODS = [72, 100, 200, 475, 975, 2475, 3000];
const RECORD_FLOAT_COUNT = 36;
const DEFAULT_MAP_CENTER = [36.85, -120.15];
const DEFAULT_MAP_ZOOM = 6;
const { metadataRoot: METADATA_ROOT, binaryRoot: BINARY_ROOT } = resolveDataRoots();

const COLORS = {
  navy: "#11314c",
  aqua: "#22b7a7",
  gold: "#f3c26b",
  coral: "#e56752",
  blue: "#2563eb",
  slate: "#60748a",
};

const state = {
  index: null,
  map: null,
  gridLayerGroup: null,
  gridRectangles: new Map(),
  selectedMarker: null,
  selectedGridName: null,
  selectedSelection: null,
  manifestCache: new Map(),
  depthChart: null,
  combinedChart: null,
};

const dom = {
  mapStatusPill: document.getElementById("mapStatusPill"),
  selectedGridLabel: document.getElementById("selectedGridLabel"),
  selectedPointLabel: document.getElementById("selectedPointLabel"),
  gridCountLabel: document.getElementById("gridCountLabel"),
  selectionTitle: document.getElementById("selectionTitle"),
  queryStatusPill: document.getElementById("queryStatusPill"),
  selectionBanner: document.getElementById("selectionBanner"),
  curvesEmptyState: document.getElementById("curvesEmptyState"),
  curvesContent: document.getElementById("curvesContent"),
  depthChartTitle: document.getElementById("depthChartTitle"),
  depthChartMeta: document.getElementById("depthChartMeta"),
  combinedChartTitle: document.getElementById("combinedChartTitle"),
  combinedChartMeta: document.getElementById("combinedChartMeta"),
  depthChartCanvas: document.getElementById("depthChartCanvas"),
  combinedChartCanvas: document.getElementById("combinedChartCanvas"),
};

const emptyStateMessagePlugin = {
  id: "emptyStateMessage",
  afterDraw(chart, args, options) {
    const message = options?.message;
    if (!message || !chart.chartArea) {
      return;
    }

    const datasets = chart.data?.datasets || [];
    const hasData = datasets.some((dataset) => (
      (dataset.data || []).some((point) => {
        if (point == null) {
          return false;
        }
        if (typeof point === "number") {
          return Number.isFinite(point);
        }
        if (typeof point === "object" && "y" in point) {
          return Number.isFinite(point.y);
        }
        return false;
      })
    ));

    if (hasData) {
      return;
    }

    const { left, right, top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = options.color || COLORS.slate;
    ctx.font = options.font || "600 13px Manrope, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, (left + right) / 2, (top + bottom) / 2);
    ctx.restore();
  },
};

Chart.register(emptyStateMessagePlugin);

init().catch((error) => {
  console.error(error);
  setQueryStatus("Initialization failed");
  setBanner("The explorer could not initialize. Check the browser console for details.", "error");
});

async function init() {
  setBanner("Loading factored grid index...", "info");
  state.index = normalizeIndex(await fetchJSON(buildMetadataUrl("index.json")));
  initCharts();
  initMap();
  resetSelectionDisplay();

  dom.gridCountLabel.textContent = `${state.index.grids.length} grids`;
  dom.mapStatusPill.textContent = `${state.index.grids.length} coastal grids`;
  setQueryStatus("Awaiting selection");
  setBanner("Click within a yellow grid extent on the map to retrieve a precomputed hazard curve record.", "info");

  const requestedLatLng = getRequestedLatLngFromLocation();
  if (requestedLatLng) {
    state.map.setView([requestedLatLng.lat, requestedLatLng.lng], Math.max(state.map.getZoom(), 10));
    await handleMapSelection(requestedLatLng);
  }
}

function normalizeIndex(rawIndex) {
  const grids = rawIndex.grids.map((grid) => ({
    ...grid,
    manifest: normalizeRelativePath(grid.manifest),
    binary: normalizeRelativePath(grid.binary),
    numRows: Number(grid.numRows),
    numCols: Number(grid.numCols),
    numCells: Number(grid.numCells),
    binaryBytes: Number(grid.binaryBytes),
    area: Math.abs(
      (Number(grid.bounds180.maxLatitude) - Number(grid.bounds180.minLatitude)) *
      (Number(grid.bounds180.maxLongitude) - Number(grid.bounds180.minLongitude))
    ),
  }));

  return {
    ...rawIndex,
    recordLengthBytes: Number(rawIndex.recordLengthBytes),
    fields: rawIndex.fields || [],
    grids,
  };
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    minZoom: 5,
    maxZoom: 20,
  }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Imagery (c) Esri",
      maxNativeZoom: 19,
      maxZoom: 22,
    }
  ).addTo(state.map);

  L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Labels (c) Esri",
      maxNativeZoom: 19,
      maxZoom: 22,
      opacity: 0.9,
    }
  ).addTo(state.map);

  state.gridLayerGroup = L.featureGroup().addTo(state.map);

  state.index.grids.forEach((grid) => {
    const bounds = toLeafletBounds(grid.bounds180);
    const rectangle = L.rectangle(bounds, getGridRectangleStyle(false)).addTo(state.gridLayerGroup);
    rectangle.bindTooltip(formatGridDisplayName(grid.gridName), {
      sticky: true,
      direction: "top",
      className: "grid-label-tooltip",
      opacity: 1,
    });
    state.gridRectangles.set(grid.gridName, rectangle);
  });
  state.map.on("click", (event) => {
    handleMapSelection(event.latlng).catch((error) => {
      console.error(error);
      setQueryStatus("Lookup failed");
      setBanner(error.message || "The lookup request failed.", "error");
    });
  });

  const refreshInitialView = () => {
    state.map.invalidateSize(false);
    if (!state.selectedSelection) {
      state.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, { animate: false });
    }
  };

  window.addEventListener("resize", refreshInitialView);
  window.requestAnimationFrame(() => {
    refreshInitialView();
    window.setTimeout(refreshInitialView, 250);
  });
}

function initCharts() {
  state.depthChart = new Chart(dom.depthChartCanvas, {
    type: "line",
    data: {
      datasets: [],
    },
    options: buildDepthChartOptions("Click inside a yellow grid extent to plot a hazard curve."),
  });

  state.combinedChart = new Chart(dom.combinedChartCanvas, {
    type: "line",
    data: {
      datasets: [],
    },
    options: buildCombinedChartOptions("Velocity and momentum flux will appear after a valid map selection."),
  });
}

function buildDepthChartOptions(emptyMessage) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "nearest",
      intersect: false,
    },
    plugins: {
      legend: {
        position: "top",
        labels: {
          usePointStyle: true,
          boxWidth: 10,
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
      },
      tooltip: {
        callbacks: {
          title(items) {
            return items.length ? `${items[0].parsed.x}-year return period` : "";
          },
          label(context) {
            const value = context.parsed.y;
            if (!Number.isFinite(value)) {
              return `${context.dataset.label}: no data`;
            }
            return `${context.dataset.label}: ${value.toFixed(3)} ${context.dataset.units || ""}`.trim();
          },
        },
      },
      emptyStateMessage: {
        message: emptyMessage,
      },
    },
    scales: {
      x: buildReturnPeriodAxis(),
      y: {
        min: 0,
        title: {
          display: true,
          text: "Hazard value (m)",
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
        grid: {
          color: "rgba(17, 49, 76, 0.08)",
        },
        ticks: {
          color: COLORS.slate,
        },
      },
    },
  };
}

function buildCombinedChartOptions(emptyMessage) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "nearest",
      intersect: false,
    },
    plugins: {
      legend: {
        position: "top",
        labels: {
          usePointStyle: true,
          boxWidth: 10,
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
      },
      tooltip: {
        callbacks: {
          title(items) {
            return items.length ? `${items[0].parsed.x}-year return period` : "";
          },
          label(context) {
            const value = context.parsed.y;
            if (!Number.isFinite(value)) {
              return `${context.dataset.label}: no data`;
            }
            return `${context.dataset.label}: ${value.toFixed(3)} ${context.dataset.units || ""}`.trim();
          },
        },
      },
      emptyStateMessage: {
        message: emptyMessage,
      },
    },
    scales: {
      x: buildReturnPeriodAxis(),
      y: {
        position: "left",
        min: 0,
        title: {
          display: true,
          text: "Velocity (m/s)",
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
        grid: {
          color: "rgba(17, 49, 76, 0.08)",
        },
        ticks: {
          color: COLORS.slate,
        },
      },
      y1: {
        position: "right",
        min: 0,
        title: {
          display: true,
          text: "Momentum flux (m^3/s^2)",
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          color: COLORS.slate,
        },
      },
    },
  };
}

function buildReturnPeriodAxis() {
  return {
    type: "logarithmic",
    min: 60,
    max: 3500,
    afterBuildTicks(scale) {
      scale.ticks = RETURN_PERIODS.map((value) => ({ value }));
    },
    title: {
      display: true,
      text: "Return period (years)",
      color: COLORS.navy,
      font: {
        family: "Manrope",
        weight: "700",
      },
    },
    grid: {
      color: "rgba(17, 49, 76, 0.08)",
    },
    ticks: {
      color: COLORS.slate,
      callback(value) {
        const numericValue = Number(value);
        return RETURN_PERIODS.includes(numericValue) ? String(numericValue) : "";
      },
    },
  };
}

async function handleMapSelection(latlng) {
  const grid = findContainingGrid(latlng);
  if (!grid) {
    resetSelectionDisplay();
    setQueryStatus("Outside gridded coverage");
    setBanner("That location falls outside the yellow gridded extents, so no lookup was run.", "warning");
    return;
  }

  setQueryStatus("Loading selection...");
  setBanner(`Loading hazard record from ${grid.gridName.replace(/_/g, " ")}...`, "info");

  const manifest = await getGridManifest(grid);
  const cell = latLngToRowCol(latlng, manifest);
  const record = await fetchBinaryRecord(grid.binary, cell.recordOffsetBytes, manifest.recordLengthBytes);
  const selection = buildSelection(grid, manifest, latlng, cell, record);

  state.selectedGridName = grid.gridName;
  state.selectedSelection = selection;

  updateGridHighlight();
  updateSelectedMarker(selection);
  renderCharts(selection);

  dom.selectedGridLabel.textContent = formatGridDisplayName(selection.gridName);
  dom.selectedPointLabel.textContent = `${selection.cellCenter.latitude.toFixed(4)}, ${selection.cellCenter.longitude.toFixed(4)}`;
  dom.selectionTitle.textContent = `${formatGridDisplayName(selection.gridName)} Grid. Lat/Lon clicked ${selection.clicked.latitude.toFixed(4)}, ${selection.clicked.longitude.toFixed(4)} with DEM Elevation of ${formatValue(selection.topo, 1)} m (MHW).`;

  setQueryStatus("Lookup complete");
  clearBanner();
  showCurvesDisplay();
}

function findContainingGrid(latlng) {
  const containingGrids = state.index.grids.filter((grid) => containsLatLng(latlng, grid.bounds180));
  if (!containingGrids.length) {
    return null;
  }
  return containingGrids.sort((left, right) => left.area - right.area)[0];
}

async function getGridManifest(grid) {
  if (state.manifestCache.has(grid.gridName)) {
    return state.manifestCache.get(grid.gridName);
  }

  const manifest = await fetchJSON(buildMetadataUrl(grid.manifest));
  manifest.recordLengthBytes = Number(manifest.recordLengthBytes);
  manifest.gridGeometry.nRows = Number(manifest.gridGeometry.nRows);
  manifest.gridGeometry.nCols = Number(manifest.gridGeometry.nCols);
  manifest.gridGeometry.topEdgeLatitude = Number(manifest.gridGeometry.topEdgeLatitude);
  manifest.gridGeometry.westEdgeLongitude360 = Number(manifest.gridGeometry.westEdgeLongitude360);
  manifest.gridGeometry.cellSizeLatitude = Number(manifest.gridGeometry.cellSizeLatitude);
  manifest.gridGeometry.cellSizeLongitude = Number(manifest.gridGeometry.cellSizeLongitude);
  state.manifestCache.set(grid.gridName, manifest);
  return manifest;
}

function latLngToRowCol(latlng, manifest) {
  const geometry = manifest.gridGeometry;
  const lon360 = normalizeLongitude360(latlng.lng);

  let row = Math.floor((geometry.topEdgeLatitude - latlng.lat) / geometry.cellSizeLatitude);
  let col = Math.floor((lon360 - geometry.westEdgeLongitude360) / geometry.cellSizeLongitude);

  row = clamp(row, 0, geometry.nRows - 1);
  col = clamp(col, 0, geometry.nCols - 1);

  const offsetIndex = row * geometry.nCols + col;
  const recordOffsetBytes = offsetIndex * manifest.recordLengthBytes;
  const cellCenterLatitude = geometry.topEdgeLatitude - (row + 0.5) * geometry.cellSizeLatitude;
  const cellCenterLongitude360 = geometry.westEdgeLongitude360 + (col + 0.5) * geometry.cellSizeLongitude;

  return {
    row,
    col,
    recordOffsetBytes,
    cellCenter: {
      latitude: cellCenterLatitude,
      longitude: wrapTo180(cellCenterLongitude360),
      longitude360: cellCenterLongitude360,
    },
  };
}

async function fetchBinaryRecord(relativeBinaryPath, byteOffset, recordLengthBytes) {
  const byteRange = `bytes=${byteOffset}-${byteOffset + recordLengthBytes - 1}`;
  const response = await fetch(buildBinaryUrl(relativeBinaryPath), {
    headers: {
      Range: byteRange,
    },
  });

  const contentRange = response.headers.get("Content-Range");
  if (response.status !== 206 && !contentRange) {
    throw new Error(
      "This server is not honoring HTTP Range requests. For local development, run `node serve-range.js` from the project root."
    );
  }

  if (!response.ok) {
    throw new Error(`Lookup request failed with status ${response.status}.`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== recordLengthBytes) {
    throw new Error(`Expected ${recordLengthBytes} bytes but received ${buffer.byteLength}.`);
  }

  if (recordLengthBytes !== RECORD_FLOAT_COUNT * 4) {
    throw new Error(`Unexpected record length ${recordLengthBytes}.`);
  }

  const view = new DataView(buffer);
  return Array.from({ length: RECORD_FLOAT_COUNT }, (_, index) => view.getFloat32(index * 4, true));
}

function buildSelection(grid, manifest, latlng, cell, record) {
  const topo = sanitizeTopoValue(record[0]);
  const flowDepth = sanitizeHazardCurve(record.slice(1, 8));
  const sourceAmplitude = sanitizeHazardCurve(record.slice(15, 22));
  const velocity = sanitizeHazardCurve(record.slice(22, 29));
  const momentumFlux = sanitizeHazardCurve(record.slice(29, 36));
  const isInitiallyWet = Number.isFinite(topo) && topo < 0;
  const primaryCurve = buildPrimaryCurve({
    isInitiallyWet,
    flowDepth,
    sourceAmplitude,
  });

  return {
    gridName: grid.gridName,
    clicked: {
      latitude: latlng.lat,
      longitude: latlng.lng,
    },
    row: cell.row,
    col: cell.col,
    cellCenter: cell.cellCenter,
    topo,
    isInitiallyWet,
    primaryCurve,
    primaryCurveLabel: isInitiallyWet
      ? "Amplitude"
      : "Flow depth",
    primaryCurveUnits: "m",
    flowDepth,
    sourceAmplitude,
    velocity,
    momentumFlux,
    manifest,
    queryBytes: manifest.recordLengthBytes,
    hasAnyPrimaryData: primaryCurve.some(Number.isFinite),
    hasAnyCombinedData: [...velocity, ...momentumFlux].some(Number.isFinite),
  };
}

function renderCharts(selection) {
  const primaryData = buildCurveDataset(selection.primaryCurve);
  const velocityData = buildCurveDataset(selection.velocity);
  const momentumData = buildCurveDataset(selection.momentumFlux);

  dom.depthChartTitle.textContent = selection.isInitiallyWet
    ? "Amplitude Hazard Curve"
    : "Flow Depth Hazard Curve";
  dom.depthChartMeta.textContent = selection.isInitiallyWet
    ? "Wet cell: amplitude from source amplitude raster"
    : "Dry cell: flow depth from source flow-depth raster";

  dom.combinedChartTitle.textContent = "Velocity + Momentum Flux Hazard Curves";
  dom.combinedChartMeta.textContent = `Cell row ${selection.row}, col ${selection.col}`;

  state.depthChart.options.scales.y.title.text = selection.isInitiallyWet
    ? "Amplitude (m)"
    : "Flow Depth (m)";
  state.depthChart.options.plugins.emptyStateMessage.message = selection.hasAnyPrimaryData
    ? ""
    : selection.isInitiallyWet
      ? "No valid amplitude values were stored for this cell."
      : "No valid flow-depth values were stored for this cell.";
  state.depthChart.data.datasets = [
    {
      label: selection.primaryCurveLabel,
      units: selection.primaryCurveUnits,
      data: primaryData,
      borderColor: COLORS.blue,
      backgroundColor: "rgba(37, 99, 235, 0.16)",
      pointBackgroundColor: COLORS.coral,
      pointBorderColor: COLORS.blue,
      pointRadius: 4.5,
      pointHoverRadius: 5.5,
      borderWidth: 2.4,
      tension: 0.16,
      spanGaps: false,
    },
  ];
  state.depthChart.update();

  state.combinedChart.options.plugins.emptyStateMessage.message = selection.hasAnyCombinedData
    ? ""
    : "No valid velocity or momentum values were stored for this cell.";
  state.combinedChart.data.datasets = [
    {
      label: "Velocity",
      units: "m/s",
      yAxisID: "y",
      data: velocityData,
      borderColor: COLORS.aqua,
      backgroundColor: "rgba(34, 183, 167, 0.12)",
      pointBackgroundColor: COLORS.aqua,
      pointBorderColor: COLORS.navy,
      pointRadius: 4.3,
      pointHoverRadius: 5.3,
      borderWidth: 2.2,
      tension: 0.16,
      spanGaps: false,
    },
    {
      label: "Momentum flux",
      units: "m^3/s^2",
      yAxisID: "y1",
      data: momentumData,
      borderColor: COLORS.coral,
      backgroundColor: "rgba(229, 103, 82, 0.12)",
      pointBackgroundColor: COLORS.gold,
      pointBorderColor: COLORS.coral,
      pointRadius: 4.3,
      pointHoverRadius: 5.3,
      borderWidth: 2.2,
      tension: 0.16,
      spanGaps: false,
    },
  ];
  state.combinedChart.update();
}

function buildCurveDataset(values) {
  return RETURN_PERIODS.map((returnPeriod, index) => ({
    x: returnPeriod,
    y: Number.isFinite(values[index]) ? values[index] : null,
  }));
}

function updateSelectedMarker(selection) {
  const latLng = [selection.cellCenter.latitude, selection.cellCenter.longitude];
  if (!state.selectedMarker) {
    state.selectedMarker = L.circleMarker(latLng, {
      radius: 7,
      weight: 2,
      color: COLORS.coral,
      fillColor: COLORS.gold,
      fillOpacity: 0.95,
    }).addTo(state.map);
  } else {
    state.selectedMarker.setLatLng(latLng);
  }

  state.selectedMarker.bindTooltip(
    `${formatGridDisplayName(selection.gridName)}<br>${selection.cellCenter.latitude.toFixed(4)}, ${selection.cellCenter.longitude.toFixed(4)}`,
    {
      direction: "top",
      offset: [0, -8],
      className: "grid-label-tooltip",
      opacity: 1,
    }
  );
}

function updateGridHighlight() {
  state.gridRectangles.forEach((rectangle, gridName) => {
    rectangle.setStyle(getGridRectangleStyle(gridName === state.selectedGridName));
  });
}

function getGridRectangleStyle(isSelected) {
  if (isSelected) {
    return {
      color: COLORS.coral,
      weight: 2.6,
      fillColor: COLORS.gold,
      fillOpacity: 0.08,
      opacity: 0.95,
    };
  }

  return {
    color: COLORS.gold,
    weight: 1.5,
    fillColor: COLORS.gold,
    fillOpacity: 0.03,
    opacity: 0.9,
  };
}

function containsLatLng(latlng, bounds180) {
  return latlng.lat >= Number(bounds180.minLatitude) &&
    latlng.lat <= Number(bounds180.maxLatitude) &&
    latlng.lng >= Number(bounds180.minLongitude) &&
    latlng.lng <= Number(bounds180.maxLongitude);
}

function toLeafletBounds(bounds180) {
  return [
    [Number(bounds180.minLatitude), Number(bounds180.minLongitude)],
    [Number(bounds180.maxLatitude), Number(bounds180.maxLongitude)],
  ];
}

function setQueryStatus(message) {
  dom.queryStatusPill.textContent = message;
}

function setBanner(message, type = "info") {
  dom.selectionBanner.classList.remove("hidden");
  dom.selectionBanner.textContent = message;
  dom.selectionBanner.classList.remove("warning", "error");
  if (type === "warning") {
    dom.selectionBanner.classList.add("warning");
  }
  if (type === "error") {
    dom.selectionBanner.classList.add("error");
  }
}

function clearBanner() {
  dom.selectionBanner.classList.add("hidden");
}

function showCurvesDisplay() {
  dom.curvesEmptyState.classList.add("hidden");
  dom.curvesContent.classList.remove("hidden");
}

function resetSelectionDisplay() {
  state.selectedGridName = null;
  state.selectedSelection = null;

  dom.selectedGridLabel.textContent = "None";
  dom.selectedPointLabel.textContent = "No point";
  dom.selectionTitle.textContent = "Select a coastal location";

  updateGridHighlight();

  if (state.selectedMarker && state.map?.hasLayer(state.selectedMarker)) {
    state.map.removeLayer(state.selectedMarker);
  }
  state.selectedMarker = null;

  dom.curvesContent.classList.add("hidden");
  dom.curvesEmptyState.classList.remove("hidden");
}

function fetchJSON(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed for ${url} with status ${response.status}`);
    }
    return response.json();
  });
}

function getRequestedLatLngFromLocation() {
  const url = new URL(window.location.href);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

function normalizeRelativePath(path) {
  return String(path).replaceAll("\\", "/");
}

function resolveDataRoots() {
  const url = new URL(window.location.href);
  const sharedQueryValue = url.searchParams.get("dataBaseUrl");
  const sharedGlobalValue = globalThis.PTHA_DATA_BASE_URL;
  const metadataQueryValue = url.searchParams.get("metadataBaseUrl");
  const binaryQueryValue = url.searchParams.get("binaryBaseUrl");
  const metadataGlobalValue = globalThis.PTHA_METADATA_BASE_URL;
  const binaryGlobalValue = globalThis.PTHA_BINARY_BASE_URL;
  const sharedValue = sharedQueryValue || sharedGlobalValue;

  return {
    metadataRoot: normalizeDataRoot(metadataQueryValue || metadataGlobalValue || sharedValue || "./metadata"),
    binaryRoot: normalizeDataRoot(binaryQueryValue || binaryGlobalValue || sharedValue || "./data_factored"),
  };
}

function normalizeDataRoot(path) {
  return String(path).replaceAll("\\", "/").replace(/\/+$/, "");
}

function buildMetadataUrl(relativePath) {
  return `${METADATA_ROOT}/${normalizeRelativePath(relativePath).replace(/^\/+/, "")}`;
}

function buildBinaryUrl(relativePath) {
  return `${BINARY_ROOT}/${normalizeRelativePath(relativePath).replace(/^\/+/, "")}`;
}

function formatGridDisplayName(gridName) {
  return String(gridName).replace(/^\d+_/, "").replaceAll("_", " ");
}

function normalizeLongitude360(longitude) {
  const normalized = longitude % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function wrapTo180(longitude) {
  let wrapped = longitude;
  while (wrapped > 180) {
    wrapped -= 360;
  }
  while (wrapped <= -180) {
    wrapped += 360;
  }
  return wrapped;
}

function sanitizeTopoValue(value) {
  if (!Number.isFinite(value) || value <= -9990) {
    return NaN;
  }
  return value;
}

function sanitizeHazardCurve(values) {
  return values.map(sanitizeHazardValue);
}

function buildPrimaryCurve({ isInitiallyWet, flowDepth, sourceAmplitude }) {
  return isInitiallyWet ? sourceAmplitude : flowDepth;
}

function sanitizeHazardValue(value) {
  if (Number.isFinite(value)) {
    return value <= -9990 ? NaN : value;
  }
  return NaN;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatValue(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "NaN";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
