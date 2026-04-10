const RETURN_PERIODS = [72, 100, 200, 475, 975, 2475, 3000];
const RECORD_FLOAT_COUNT = 36;
const DEFAULT_MAP_CENTER = [36.85, -120.15];
const DEFAULT_MAP_ZOOM = 6;
const INUNDATION_MIN_ZOOM = 8;
const FEET_PER_METER = 3.280839895;
const CUBIC_FEET_PER_CUBIC_METER = 35.314666721;
const {
  metadataRoot: METADATA_ROOT,
  binaryRoot: BINARY_ROOT,
  inundationRoot: INUNDATION_ROOT,
} = resolveDataRoots();

const COLORS = {
  navy: "#11314c",
  aqua: "#22b7a7",
  gold: "#f3c26b",
  coral: "#e56752",
  blue: "#2563eb",
  slate: "#60748a",
};

const INUNDATION_COLORS = new Map([
  [72, "#2f6df6"],
  [100, "#15aabf"],
  [200, "#2da44e"],
  [475, "#d4a017"],
  [975, "#f08c00"],
  [2475, "#e56752"],
  [3000, "#b42318"],
]);

const state = {
  index: null,
  inundationIndex: null,
  map: null,
  gridLayerGroup: null,
  inundationLayerGroup: null,
  gridRectangles: new Map(),
  inundationCache: new Map(),
  inundationGridLayers: new Map(),
  inundationLegendVisible: false,
  inundationUpdateToken: 0,
  selectedMarker: null,
  selectedGridName: null,
  selectedSelection: null,
  manifestCache: new Map(),
  depthChart: null,
  combinedChart: null,
  unitSystem: "metric",
};

const dom = {
  selectedGridLabel: document.getElementById("selectedGridLabel"),
  selectedPointLabel: document.getElementById("selectedPointLabel"),
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
  unitToggleButtons: Array.from(document.querySelectorAll(".unit-toggle-button")),
  inundationLegend: document.getElementById("inundationLegend"),
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
  state.inundationIndex = await loadInundationIndex();
  initCharts();
  initMap();
  initUnitToggle();
  resetSelectionDisplay();

  setQueryStatus("Awaiting selection");
  setBanner("Click within a yellow grid extent on the map to retrieve a precomputed hazard curve record.", "info");

  const requestedLatLng = getRequestedLatLngFromLocation();
  if (requestedLatLng) {
    state.map.setView([requestedLatLng.lat, requestedLatLng.lng], Math.max(state.map.getZoom(), 10));
    await handleMapSelection(requestedLatLng);
  }
}

function initUnitToggle() {
  updateUnitToggleUi();
  dom.unitToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setUnitSystem(button.dataset.unitSystem);
    });
  });
}

function setUnitSystem(nextUnitSystem) {
  if (nextUnitSystem !== "metric" && nextUnitSystem !== "english") {
    return;
  }

  state.unitSystem = nextUnitSystem;
  updateUnitToggleUi();

  if (state.selectedSelection) {
    renderSelectionDetails(state.selectedSelection);
    renderCharts(state.selectedSelection);
  }
}

function updateUnitToggleUi() {
  dom.unitToggleButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.unitSystem === state.unitSystem);
  });
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
  state.inundationLayerGroup = L.featureGroup().addTo(state.map);

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
  state.map.on("moveend zoomend", () => {
    updateInundationOverlays().catch((error) => {
      console.error("Failed to update inundation overlays.", error);
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
    window.setTimeout(() => {
      updateInundationOverlays().catch((error) => {
        console.error("Failed to update inundation overlays.", error);
      });
    }, 300);
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
    options: buildCombinedChartOptions("Maximum tsunami velocity and maximum tsunami momentum flux will appear after a valid map selection."),
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
          text: "Maximum Tsunami Velocity (m/s)",
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
          text: "Maximum Tsunami Momentum Flux (m^3/s^2)",
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
  renderSelectionDetails(selection);
  renderCharts(selection);

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
      ? "Maximum Tsunami Crest Elevation"
      : "Maximum Tsunami Flow Depth",
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
  const primaryData = buildCurveDataset(convertCurveValues(selection.primaryCurve, "length"));
  const velocityData = buildCurveDataset(convertCurveValues(selection.velocity, "velocity"));
  const momentumData = buildCurveDataset(convertCurveValues(selection.momentumFlux, "momentumFlux"));
  const lengthUnit = getUnitLabel("length");
  const velocityUnit = getUnitLabel("velocity");
  const momentumFluxUnit = getUnitLabel("momentumFlux");

  dom.depthChartTitle.textContent = selection.isInitiallyWet
    ? "Maximum Tsunami Crest Elevation Hazard Curve"
    : "Maximum Tsunami Flow Depth Hazard Curve";
  dom.depthChartMeta.textContent = selection.isInitiallyWet
    ? "Wet cell: maximum tsunami crest elevation from the source amplitude raster"
    : "Dry cell: maximum tsunami flow depth from the source flow-depth raster";

  dom.combinedChartTitle.textContent = "Maximum Tsunami Velocity + Maximum Tsunami Momentum Flux Hazard Curves";
  dom.combinedChartMeta.textContent = "Dual-axis plot";

  state.depthChart.options.scales.y.title.text = selection.isInitiallyWet
    ? `Maximum Tsunami Crest Elevation (${lengthUnit})`
    : `Maximum Tsunami Flow Depth (${lengthUnit})`;
  state.depthChart.options.plugins.emptyStateMessage.message = selection.hasAnyPrimaryData
    ? ""
    : selection.isInitiallyWet
      ? "No valid maximum tsunami crest elevation values were stored for this cell."
      : "No valid maximum tsunami flow depth values were stored for this cell.";
  state.depthChart.data.datasets = [
    {
      label: selection.primaryCurveLabel,
      units: lengthUnit,
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

  state.combinedChart.options.scales.y.title.text = `Maximum Tsunami Velocity (${velocityUnit})`;
  state.combinedChart.options.scales.y1.title.text = `Maximum Tsunami Momentum Flux (${momentumFluxUnit})`;
  state.combinedChart.options.plugins.emptyStateMessage.message = selection.hasAnyCombinedData
    ? ""
    : "No valid maximum tsunami velocity or momentum flux values were stored for this cell.";
  state.combinedChart.data.datasets = [
    {
      label: "Maximum Tsunami Velocity",
      units: velocityUnit,
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
      label: "Maximum Tsunami Momentum Flux",
      units: momentumFluxUnit,
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

async function loadInundationIndex() {
  try {
    return await fetchJSON(buildInundationUrl("index.json"));
  } catch (error) {
    console.warn("Unable to load inundation-limit index.", error);
    return null;
  }
}

async function updateInundationOverlays() {
  const updateToken = ++state.inundationUpdateToken;

  if (!state.map || !state.inundationLayerGroup || !state.inundationIndex) {
    clearInundationOverlays();
    hideInundationLegend();
    return;
  }

  if (!shouldRenderInundationOverlays()) {
    clearInundationOverlays();
    hideInundationLegend();
    return;
  }

  const viewBounds = state.map.getBounds();
  const visibleGrids = (state.inundationIndex.grids || [])
    .filter((grid) => intersectsMapBounds(viewBounds, grid.bounds180));
  const desiredGridNames = new Set(visibleGrids.map((grid) => grid.gridName));

  state.inundationGridLayers.forEach((layerGroup, gridName) => {
    if (!desiredGridNames.has(gridName)) {
      state.inundationLayerGroup.removeLayer(layerGroup);
      state.inundationGridLayers.delete(gridName);
    }
  });

  for (const grid of visibleGrids) {
    if (updateToken !== state.inundationUpdateToken || !shouldRenderInundationOverlays()) {
      return;
    }

    if (state.inundationGridLayers.has(grid.gridName)) {
      continue;
    }

    const layerGroup = await buildInundationLayerForGrid(grid.gridName);
    const stillVisible = intersectsMapBounds(state.map.getBounds(), grid.bounds180);
    if (
      updateToken !== state.inundationUpdateToken ||
      !shouldRenderInundationOverlays() ||
      !layerGroup ||
      !desiredGridNames.has(grid.gridName) ||
      !stillVisible
    ) {
      continue;
    }

    layerGroup.addTo(state.inundationLayerGroup);
    state.inundationGridLayers.set(grid.gridName, layerGroup);
  }

  if (updateToken !== state.inundationUpdateToken || !shouldRenderInundationOverlays()) {
    return;
  }

  if (state.inundationGridLayers.size > 0) {
    showInundationLegend();
  } else {
    hideInundationLegend();
  }
}

function clearInundationOverlays() {
  if (!state.inundationLayerGroup) {
    state.inundationGridLayers.clear();
    return;
  }

  state.inundationGridLayers.forEach((layerGroup) => {
    state.inundationLayerGroup.removeLayer(layerGroup);
  });
  state.inundationGridLayers.clear();
}

async function buildInundationLayerForGrid(gridName) {
  const inundationData = await getInundationGridData(gridName);
  if (!inundationData) {
    return null;
  }

  const layerGroup = L.layerGroup();

  for (const contourSet of normalizeJsonArray(inundationData.contourSets)) {
    const color = INUNDATION_COLORS.get(Number(contourSet.returnPeriodYears)) || COLORS.coral;
    const latLngGroups = normalizeJsonArray(contourSet.segments)
      .map((segment) => Array.isArray(segment.coordinates)
        ? segment.coordinates.map((coordinate) => [Number(coordinate[1]), Number(coordinate[0])])
        : [])
      .filter((coordinates) => coordinates.length >= 2);

    if (!latLngGroups.length) {
      continue;
    }

    L.polyline(latLngGroups, {
      color,
      weight: 5.7,
      opacity: 0.95,
      smoothFactor: 0.4,
      interactive: false,
      bubblingMouseEvents: false,
    }).addTo(layerGroup);
  }

  if (!layerGroup.getLayers().length) {
    return null;
  }

  return layerGroup;
}

async function getInundationGridData(gridName) {
  if (!state.inundationIndex) {
    return null;
  }

  if (state.inundationCache.has(gridName)) {
    return state.inundationCache.get(gridName);
  }

  const entry = (state.inundationIndex.grids || []).find((grid) => grid.gridName === gridName);
  if (!entry?.jsonFile) {
    state.inundationCache.set(gridName, null);
    return null;
  }

  try {
    const promise = fetchJSON(buildInundationUrl(entry.jsonFile));
    state.inundationCache.set(gridName, promise);
    const data = await promise;
    state.inundationCache.set(gridName, data);
    return data;
  } catch (error) {
    console.warn(`Unable to load inundation limits for ${gridName}.`, error);
    state.inundationCache.set(gridName, null);
    return null;
  }
}

function intersectsMapBounds(mapBounds, bounds180) {
  return mapBounds.intersects(L.latLngBounds(toLeafletBounds(bounds180)));
}

function shouldRenderInundationOverlays() {
  return Boolean(state.map) && state.map.getZoom() >= (state.map.getMaxZoom() - 5);
}

function normalizeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value == null) {
    return [];
  }

  return [value];
}

function showInundationLegend() {
  if (state.inundationLegendVisible) {
    return;
  }
  dom.inundationLegend.classList.remove("hidden");
  state.inundationLegendVisible = true;
}

function hideInundationLegend() {
  if (!dom.inundationLegend) {
    return;
  }
  dom.inundationLegend.classList.add("hidden");
  state.inundationLegendVisible = false;
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
  const inundationQueryValue = url.searchParams.get("inundationBaseUrl");
  const metadataGlobalValue = globalThis.PTHA_METADATA_BASE_URL;
  const binaryGlobalValue = globalThis.PTHA_BINARY_BASE_URL;
  const inundationGlobalValue = globalThis.PTHA_INUNDATION_BASE_URL;
  const sharedValue = sharedQueryValue || sharedGlobalValue;

  return {
    metadataRoot: normalizeDataRoot(metadataQueryValue || metadataGlobalValue || sharedValue || "./metadata"),
    binaryRoot: normalizeDataRoot(binaryQueryValue || binaryGlobalValue || sharedValue || "./data_factored"),
    inundationRoot: normalizeDataRoot(inundationQueryValue || inundationGlobalValue || "./inundation_limits"),
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

function buildInundationUrl(relativePath) {
  return `${INUNDATION_ROOT}/${normalizeRelativePath(relativePath).replace(/^\/+/, "")}`;
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

function renderSelectionDetails(selection) {
  const demValue = convertValue(selection.topo, "length");
  dom.selectedGridLabel.textContent = formatGridDisplayName(selection.gridName);
  dom.selectedPointLabel.textContent = `${selection.cellCenter.latitude.toFixed(4)}, ${selection.cellCenter.longitude.toFixed(4)}`;
  dom.selectionTitle.textContent = `${formatGridDisplayName(selection.gridName)} Grid. Lat/Lon clicked ${selection.clicked.latitude.toFixed(4)}, ${selection.clicked.longitude.toFixed(4)} with DEM Elevation of ${formatValue(demValue, 1)} ${getUnitLabel("length")} (MHW).`;
}

function convertCurveValues(values, quantity) {
  return values.map((value) => convertValue(value, quantity));
}

function convertValue(value, quantity) {
  if (!Number.isFinite(value)) {
    return NaN;
  }

  if (state.unitSystem === "metric") {
    return value;
  }

  switch (quantity) {
    case "length":
      return value * FEET_PER_METER;
    case "velocity":
      return value * FEET_PER_METER;
    case "momentumFlux":
      return value * CUBIC_FEET_PER_CUBIC_METER;
    default:
      return value;
  }
}

function getUnitLabel(quantity) {
  if (state.unitSystem === "metric") {
    switch (quantity) {
      case "length":
        return "m";
      case "velocity":
        return "m/s";
      case "momentumFlux":
        return "m^3/s^2";
      default:
        return "";
    }
  }

  switch (quantity) {
    case "length":
      return "ft";
    case "velocity":
      return "ft/s";
    case "momentumFlux":
      return "ft^3/s^2";
    default:
      return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
