const RETURN_PERIODS = [72, 100, 200, 475, 975, 2475, 3000];
const EXTENDED_RETURN_PERIODS = [1, ...RETURN_PERIODS];
const RECORD_FLOAT_COUNT = 36;
const DEFAULT_MAP_CENTER = [36.85, -120.15];
const DEFAULT_MAP_ZOOM = 6;
const DEFAULT_WORKBOOK_URL = "./FASTER_data/Step_03_CA%20Statewide_Manual_FASTER_Rev22_ResponseReady.xlsx";
const WORKBOOK_SHEET_NAME = "(1) Paste CA TEX Values";
const NOAA_STATIONS_CSV_URL = "./FASTER_data/noaa_ca_tide_stations.csv";
const NOAA_PREDICTIONS_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const NOAA_APPLICATION_ID = "PTHA_Forecast_Web";
const SITE_LOOKUP_CONCURRENCY = 8;
const SITE_LABEL_MIN_ZOOM = 8;
const INUNDATION_ZOOM_LEVELS_FROM_MAX = 5;
const FEET_PER_METER = 3.280839895;
const HOURS_TO_MS = 60 * 60 * 1000;
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
  green: "#2da44e",
  amber: "#f08c00",
  silver: "#8b9aad",
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
  siteMarkerLayerGroup: null,
  siteLabelLayerGroup: null,
  gridRectangles: new Map(),
  manifestCache: new Map(),
  recordCache: new Map(),
  inundationCache: new Map(),
  inundationGridLayers: new Map(),
  inundationLegendVisible: false,
  inundationUpdateToken: 0,
  selectionRequestToken: 0,
  tideStationsPromise: null,
  tideCache: new Map(),
  workbookSourceLabel: "Loading...",
  workbookSites: [],
  analyzedSites: [],
  forecastSites: [],
  forecastSitesWithAmplitude: [],
  gridForecasts: new Map(),
  selectedMarker: null,
  selectedSiteMarker: null,
  selectedGridName: null,
  selectedClickLatLng: null,
  selectedSelection: null,
  tideChart: null,
  hazardChart: null,
  unitSystem: "metric",
  timeMode: "utc",
};

const dom = {
  loadWorkbookButton: document.getElementById("loadWorkbookButton"),
  workbookInput: document.getElementById("workbookInput"),
  topbarWorkbookStatus: document.getElementById("topbarWorkbookStatus"),
  selectedGridLabel: document.getElementById("selectedGridLabel"),
  gridEventReturnPeriodLabel: document.getElementById("gridEventReturnPeriodLabel"),
  selectedPointLabel: document.getElementById("selectedPointLabel"),
  nearestSiteLabel: document.getElementById("nearestSiteLabel"),
  selectionTitle: document.getElementById("selectionTitle"),
  selectionBanner: document.getElementById("selectionBanner"),
  workbookSourceLabel: document.getElementById("workbookSourceLabel"),
  forecastEmptyState: document.getElementById("forecastEmptyState"),
  forecastContent: document.getElementById("forecastContent"),
  tideChartCanvas: document.getElementById("tideChartCanvas"),
  hazardChartCanvas: document.getElementById("hazardChartCanvas"),
  tideChartTitle: document.getElementById("tideChartTitle"),
  tideChartMeta: document.getElementById("tideChartMeta"),
  hazardChartTitle: document.getElementById("hazardChartTitle"),
  hazardChartMeta: document.getElementById("hazardChartMeta"),
  unitToggleButtons: Array.from(document.querySelectorAll(".unit-toggle-button[data-unit-system]")),
  timeToggleButtons: Array.from(document.querySelectorAll(".unit-toggle-button[data-time-mode]")),
  inundationLegend: document.getElementById("inundationLegend"),
  inundationLegendList: document.getElementById("inundationLegendList"),
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

const verticalReferenceLinePlugin = {
  id: "verticalReferenceLine",
  afterDatasetsDraw(chart, args, options) {
    const value = Number(options?.value);
    if (!Number.isFinite(value) || !chart.scales?.x || !chart.chartArea) {
      return;
    }

    const x = chart.scales.x.getPixelForValue(value);
    if (!Number.isFinite(x)) {
      return;
    }

    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = options.color || COLORS.coral;
    ctx.lineWidth = options.width || 2;
    ctx.setLineDash(options.dash || [8, 6]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    if (options.label) {
      ctx.fillStyle = options.color || COLORS.coral;
      ctx.font = "700 11px Manrope, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(options.label, x + 6, top + 6);
    }
    ctx.restore();
  },
};

Chart.register(emptyStateMessagePlugin, verticalReferenceLinePlugin);

init().catch((error) => {
  console.error(error);
  setBanner("The forecast page could not initialize. Check the browser console for details.", "error");
});

async function init() {
  setBanner("Loading PTHA metadata, inundation limits, and NOAA stations.", "info");

  const [rawIndex, inundationIndex] = await Promise.all([
    fetchJSON(buildMetadataUrl("index.json")),
    loadInundationIndex(),
  ]);

  state.index = normalizeIndex(rawIndex);
  state.inundationIndex = inundationIndex;
  state.tideStationsPromise = fetchCaliforniaTideStations();

  initCharts();
  initMap();
  initControls();
  resetSelectionDisplay();

  await loadBundledWorkbook();

  setBanner("Click any map location to plot NOAA tides, tsunami envelope, and the clicked-location PTHA hazard curve.", "info");
}

function initControls() {
  updateUnitToggleUi();
  updateTimeToggleUi();

  dom.unitToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setUnitSystem(button.dataset.unitSystem);
    });
  });

  dom.timeToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setTimeMode(button.dataset.timeMode);
    });
  });

  dom.loadWorkbookButton.addEventListener("click", () => {
    dom.workbookInput.click();
  });

  dom.workbookInput.addEventListener("change", async (event) => {
    const [file] = Array.from(event.target.files || []);
    if (!file) {
      return;
    }

    try {
      await loadWorkbookFromFile(file);
    } catch (error) {
      console.error(error);
      setBanner(error.message || "Unable to parse the selected workbook.", "error");
    } finally {
      event.target.value = "";
    }
  });
}

function initCharts() {
  state.tideChart = new Chart(dom.tideChartCanvas, {
    type: "line",
    data: { datasets: [] },
    options: buildTideChartOptions("Click any map location to load NOAA tides and the site-based tsunami envelope."),
  });

  state.hazardChart = new Chart(dom.hazardChartCanvas, {
    type: "line",
    data: { datasets: [] },
    options: buildHazardChartOptions("Click inside a PTHA grid to load the clicked-location event hazard curve."),
  });
}

function initMap() {
  state.map = L.map("forecastMap", {
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
  state.siteMarkerLayerGroup = L.featureGroup().addTo(state.map);
  state.siteLabelLayerGroup = L.layerGroup().addTo(state.map);

  state.index.grids.forEach((grid) => {
    const rectangle = L.rectangle(toLeafletBounds(grid.bounds180), getGridRectangleStyle(false)).addTo(state.gridLayerGroup);
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
      setBanner(error.message || "The selected location could not be processed.", "error");
    });
  });

  state.map.on("moveend zoomend", () => {
    updateInundationOverlays().catch((error) => {
      console.error("Failed to update inundation overlays.", error);
    });
    updateSiteLabels();
  });

  const refreshInitialView = () => {
    state.map.invalidateSize(false);
    if (!state.selectedClickLatLng) {
      state.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, { animate: false });
    }
  };

  window.addEventListener("resize", refreshInitialView);
  window.requestAnimationFrame(() => {
    refreshInitialView();
    window.setTimeout(refreshInitialView, 250);
  });
}

async function loadBundledWorkbook() {
  setTopbarWorkbookStatus("Bundled workbook");
  const response = await fetch(DEFAULT_WORKBOOK_URL);
  if (!response.ok) {
    throw new Error(`Bundled workbook request failed with status ${response.status}.`);
  }
  const workbookBytes = await response.arrayBuffer();
  await analyzeWorkbookArrayBuffer(workbookBytes, "Bundled workbook");
}

async function loadWorkbookFromFile(file) {
  setBanner(`Parsing workbook ${file.name}...`, "info");
  setTopbarWorkbookStatus(file.name);
  const workbookBytes = await file.arrayBuffer();
  await analyzeWorkbookArrayBuffer(workbookBytes, file.name);
}

async function analyzeWorkbookArrayBuffer(arrayBuffer, sourceLabel) {
  if (!globalThis.XLSX) {
    throw new Error("SheetJS failed to load, so the workbook could not be parsed in the browser.");
  }

  state.selectionRequestToken += 1;
  clearSelectionVisuals();
  resetCharts();

  const workbook = globalThis.XLSX.read(arrayBuffer, {
    type: "array",
    dense: false,
  });
  const sheet = workbook.Sheets[WORKBOOK_SHEET_NAME];
  if (!sheet) {
    throw new Error(`Workbook did not include the "${WORKBOOK_SHEET_NAME}" tab.`);
  }

  const rawRows = globalThis.XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
  });
  const workbookSites = rawRows
    .map(normalizeWorkbookSiteRow)
    .filter(Boolean);

  if (!workbookSites.length) {
    throw new Error("No forecast site rows were found in the workbook.");
  }

  state.workbookSourceLabel = sourceLabel;
  state.workbookSites = workbookSites;

  setBanner(`Analyzing ${workbookSites.length} workbook sites against the PTHA database...`, "info");
  const analyzedSites = await mapWithConcurrency(
    workbookSites,
    SITE_LOOKUP_CONCURRENCY,
    analyzeWorkbookSite
  );

  state.analyzedSites = analyzedSites;
  state.forecastSitesWithAmplitude = analyzedSites.filter((site) => (
    Number.isFinite(site.latitude) &&
    Number.isFinite(site.longitude) &&
    Number.isFinite(site.predictedPosAmplitudeMeters) &&
    Number.isFinite(site.predictedArrivalTimeMs)
  ));
  state.forecastSites = analyzedSites.filter((site) => site.status === "ok");
  state.gridForecasts = buildGridForecasts(state.forecastSites);

  renderWorkbookSummary();
  renderSiteMarkers();
  updateSiteLabels();
  await updateInundationOverlays();

  setTopbarWorkbookStatus(sourceLabel);
  setBanner(
    `Loaded ${workbookSites.length} workbook sites. ${state.forecastSites.length} initially wet sites produced valid event return periods across ${countFiniteGridForecasts()} grids.`,
    "info"
  );

  if (state.selectedClickLatLng) {
    await handleMapSelection(state.selectedClickLatLng);
  } else {
    resetSelectionDisplay();
  }
}

function normalizeWorkbookSiteRow(row) {
  const siteCode = String(row.siteCode ?? "").trim();
  const siteName = String(row.siteName ?? "").trim();
  const latitude = Number(row.Lat_dd);
  const longitude = Number(row.Long_dd);

  if (!siteCode || !siteName || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const predictedPosAmplitudeMeters = parseWorkbookNumber(row.predictedPosAmplitude_m);
  const predictedArrivalTimeUtc = String(row.predictedArrivalTime_UTC ?? "").trim();
  const predictedArrivalTimeMs = parseWorkbookUtcTimestamp(predictedArrivalTimeUtc);

  return {
    siteCode,
    siteName,
    latitude,
    longitude,
    predictedPosAmplitudeMeters,
    predictedArrivalTimeUtc,
    predictedArrivalTimeMs,
  };
}

async function analyzeWorkbookSite(site) {
  const latlng = {
    lat: site.latitude,
    lng: site.longitude,
  };
  const grid = findContainingGrid(latlng);

  if (!grid) {
    return {
      ...site,
      status: "outside_all_grids",
      gridName: null,
      topo: NaN,
      isInitiallyWet: false,
      eventReturnPeriodYears: NaN,
      record: null,
    };
  }

  const manifest = await getGridManifest(grid);
  const cell = latLngToRowCol(latlng, manifest);
  const record = await fetchBinaryRecord(grid.binary, cell.recordOffsetBytes, manifest.recordLengthBytes);
  const decoded = decodeLookupRecord(record);
  const amplitudeCurve = [0, ...decoded.sourceAmplitude];
  const eventReturnPeriodYears = interpolateReturnPeriodFromAmplitude(amplitudeCurve, site.predictedPosAmplitudeMeters);

  let status = "ok";
  if (!Number.isFinite(site.predictedPosAmplitudeMeters)) {
    status = "missing_predicted_amplitude";
  } else if (!decoded.isInitiallyWet) {
    status = "dry_site";
  } else if (!Number.isFinite(eventReturnPeriodYears)) {
    status = "above_curve_max";
  }

  return {
    ...site,
    status,
    gridName: grid.gridName,
    gridBounds180: grid.bounds180,
    manifest,
    row: cell.row,
    col: cell.col,
    cellCenter: cell.cellCenter,
    topo: decoded.topo,
    isInitiallyWet: decoded.isInitiallyWet,
    flowDepth: decoded.flowDepth,
    sourceAmplitude: decoded.sourceAmplitude,
    eventReturnPeriodYears,
  };
}

function buildGridForecasts(validSites) {
  const gridForecasts = new Map();
  const finiteSites = validSites.filter((site) => Number.isFinite(site.eventReturnPeriodYears));

  state.index.grids.forEach((grid) => {
    const inGridSites = finiteSites.filter((site) => site.gridName === grid.gridName);
    const gridCenter = {
      lat: mean([Number(grid.bounds180.minLatitude), Number(grid.bounds180.maxLatitude)]),
      lng: mean([Number(grid.bounds180.minLongitude), Number(grid.bounds180.maxLongitude)]),
    };

    if (inGridSites.length) {
      gridForecasts.set(grid.gridName, {
        gridName: grid.gridName,
        eventReturnPeriodYears: mean(inGridSites.map((site) => site.eventReturnPeriodYears)),
        source: "mean_in_grid",
        sourceSites: inGridSites.map((site) => site.siteCode),
        representativeSite: inGridSites[0],
      });
      return;
    }

    const nearestSite = findNearestSite(gridCenter, finiteSites);
    gridForecasts.set(grid.gridName, {
      gridName: grid.gridName,
      eventReturnPeriodYears: nearestSite?.eventReturnPeriodYears ?? NaN,
      source: nearestSite ? "nearest_site" : "none",
      sourceSites: nearestSite ? [nearestSite.siteCode] : [],
      representativeSite: nearestSite || null,
    });
  });

  return gridForecasts;
}

async function handleMapSelection(latlng) {
  const requestToken = ++state.selectionRequestToken;
  state.selectedClickLatLng = latlng;

  setForecastStatus("Loading selection");
  setBanner("Loading NOAA tides and the clicked-location PTHA hazard curve.", "info");

  const nearestSite = findNearestSite(latlng, state.forecastSites);
  if (!nearestSite) {
    throw new Error("No forecast site with a valid return period was available.");
  }
  const weightedReturnPeriodYears = computeSiteLocationWeightedReturnPeriod(latlng, state.forecastSites);

  const tideStation = await resolveTideStation(latlng);
  if (requestToken !== state.selectionRequestToken) {
    return;
  }

  const tideSeries = await loadTideSeries(
    tideStation.id,
    nearestSite.predictedArrivalTimeMs - (3 * HOURS_TO_MS),
    nearestSite.predictedArrivalTimeMs + (24 * HOURS_TO_MS)
  );
  if (requestToken !== state.selectionRequestToken) {
    return;
  }

  const grid = findContainingGrid(latlng);
  let selection = null;
  let gridForecast = null;

  if (grid) {
    const manifest = await getGridManifest(grid);
    const cell = latLngToRowCol(latlng, manifest);
    const record = await fetchBinaryRecord(grid.binary, cell.recordOffsetBytes, manifest.recordLengthBytes);
    if (requestToken !== state.selectionRequestToken) {
      return;
    }

    gridForecast = state.gridForecasts.get(grid.gridName) || null;
    selection = buildClickedSelection(grid, manifest, latlng, cell, record, weightedReturnPeriodYears);
    state.selectedGridName = grid.gridName;
  } else {
    state.selectedGridName = null;
  }

  state.selectedSelection = {
    clicked: latlng,
    nearestSite,
    weightedReturnPeriodYears,
    tideStation,
    tideSeries,
    selection,
    gridForecast,
  };

  updateGridHighlight();
  updateSelectedMarker(latlng);
  updateSelectedSiteMarker(nearestSite);
  renderSelectionDetails(state.selectedSelection);
  renderTideChart(state.selectedSelection);
  renderHazardChart(state.selectedSelection);
  showForecastDisplay();

  if (grid) {
    setBanner("Selection loaded. NOAA tides, site envelope, and grid hazard curve are shown below.", "info");
  } else {
    setBanner("That click falls outside the PTHA grids, so only the tide plot and nearest-site envelope are shown.", "warning");
  }
  setForecastStatus("Selection ready");
}

function buildClickedSelection(grid, manifest, latlng, cell, record, weightedReturnPeriodYears) {
  const decoded = decodeLookupRecord(record);
  const primaryCurve = buildPrimaryCurve({
    isInitiallyWet: decoded.isInitiallyWet,
    flowDepth: decoded.flowDepth,
    sourceAmplitude: decoded.sourceAmplitude,
  });
  const extendedPrimaryCurve = [0, ...primaryCurve];
  const eventReturnPeriodYears = Number(weightedReturnPeriodYears);
  const eventPrimaryValue = interpolateCurveValueAtReturnPeriod(extendedPrimaryCurve, eventReturnPeriodYears);

  return {
    gridName: grid.gridName,
    manifest,
    clicked: latlng,
    row: cell.row,
    col: cell.col,
    cellCenter: cell.cellCenter,
    topo: decoded.topo,
    isInitiallyWet: decoded.isInitiallyWet,
    flowDepth: decoded.flowDepth,
    sourceAmplitude: decoded.sourceAmplitude,
    primaryCurve,
    primaryCurveLabel: decoded.isInitiallyWet
      ? "Maximum Tsunami Crest Elevation"
      : "Maximum Tsunami Flow Depth",
    eventReturnPeriodYears,
    eventPrimaryValue,
  };
}

async function updateInundationOverlays() {
  const updateToken = ++state.inundationUpdateToken;

  if (!state.map || !state.inundationLayerGroup || !state.inundationIndex || !state.gridForecasts.size) {
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

  state.inundationGridLayers.forEach((entry, gridName) => {
    if (!desiredGridNames.has(gridName)) {
      state.inundationLayerGroup.removeLayer(entry.layerGroup);
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

    const entry = await buildInundationLayerForGrid(grid.gridName);
    const stillVisible = intersectsMapBounds(state.map.getBounds(), grid.bounds180);
    if (
      updateToken !== state.inundationUpdateToken ||
      !shouldRenderInundationOverlays() ||
      !entry ||
      !stillVisible
    ) {
      continue;
    }

    entry.layerGroup.addTo(state.inundationLayerGroup);
    state.inundationGridLayers.set(grid.gridName, entry);
  }

  if (updateToken !== state.inundationUpdateToken || !shouldRenderInundationOverlays()) {
    return;
  }

  const visiblePeriods = Array.from(state.inundationGridLayers.values())
    .flatMap((entry) => entry.periodsShown)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);

  if (visiblePeriods.length) {
    showInundationLegend(visiblePeriods);
  } else {
    hideInundationLegend();
  }
}

function clearInundationOverlays() {
  if (!state.inundationLayerGroup) {
    state.inundationGridLayers.clear();
    return;
  }

  state.inundationGridLayers.forEach((entry) => {
    state.inundationLayerGroup.removeLayer(entry.layerGroup);
  });
  state.inundationGridLayers.clear();
}

async function buildInundationLayerForGrid(gridName) {
  const gridForecast = state.gridForecasts.get(gridName);
  if (!gridForecast || !Number.isFinite(gridForecast.eventReturnPeriodYears)) {
    return null;
  }

  const inundationData = await getInundationGridData(gridName);
  if (!inundationData) {
    return null;
  }

  const contourSets = normalizeJsonArray(inundationData.contourSets)
    .map((contourSet) => ({
      ...contourSet,
      returnPeriodYears: Number(contourSet.returnPeriodYears),
      segments: normalizeJsonArray(contourSet.segments),
    }))
    .filter((contourSet) => contourSet.segments.some((segment) => (
      Array.isArray(segment.coordinates) && segment.coordinates.length >= 2
    )));

  if (!contourSets.length) {
    return null;
  }

  const selectedPeriods = selectBracketingReturnPeriods(
    gridForecast.eventReturnPeriodYears,
    contourSets.map((contourSet) => contourSet.returnPeriodYears)
  );

  if (!selectedPeriods.length) {
    return null;
  }

  const layerGroup = L.layerGroup();

  contourSets.forEach((contourSet) => {
    if (!selectedPeriods.includes(contourSet.returnPeriodYears)) {
      return;
    }

    const latLngGroups = contourSet.segments
      .map((segment) => Array.isArray(segment.coordinates)
        ? segment.coordinates.map((coordinate) => [Number(coordinate[1]), Number(coordinate[0])])
        : [])
      .filter((coordinates) => coordinates.length >= 2);

    if (!latLngGroups.length) {
      return;
    }

    L.polyline(latLngGroups, {
      color: INUNDATION_COLORS.get(contourSet.returnPeriodYears) || COLORS.coral,
      weight: 5.7,
      opacity: 0.95,
      smoothFactor: 0.4,
      interactive: false,
      bubblingMouseEvents: false,
    }).addTo(layerGroup);
  });

  if (!layerGroup.getLayers().length) {
    return null;
  }

  return {
    layerGroup,
    periodsShown: selectedPeriods,
  };
}

function selectBracketingReturnPeriods(eventReturnPeriodYears, availableReturnPeriods) {
  const sorted = availableReturnPeriods
    .filter(Number.isFinite)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);

  if (!sorted.length || !Number.isFinite(eventReturnPeriodYears)) {
    return [];
  }

  let lower = null;
  let upper = null;

  sorted.forEach((value) => {
    if (value <= eventReturnPeriodYears) {
      lower = value;
    }
    if (upper == null && value >= eventReturnPeriodYears) {
      upper = value;
    }
  });

  if (lower != null && upper != null && lower !== upper) {
    return [lower, upper];
  }
  if (upper != null) {
    return [upper];
  }
  if (lower != null) {
    return [lower];
  }
  return [];
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
    const request = fetchJSON(buildInundationUrl(entry.jsonFile));
    state.inundationCache.set(gridName, request);
    const data = await request;
    state.inundationCache.set(gridName, data);
    return data;
  } catch (error) {
    console.warn(`Unable to load inundation limits for ${gridName}.`, error);
    state.inundationCache.set(gridName, null);
    return null;
  }
}

async function loadInundationIndex() {
  try {
    return await fetchJSON(buildInundationUrl("index.json"));
  } catch (error) {
    console.warn("Unable to load inundation-limit index.", error);
    return null;
  }
}

function renderWorkbookSummary() {
  dom.workbookSourceLabel.textContent = state.workbookSourceLabel;
}

function renderSiteMarkers() {
  if (!state.siteMarkerLayerGroup) {
    return;
  }

  state.siteMarkerLayerGroup.clearLayers();

  state.analyzedSites.forEach((site) => {
    const marker = L.circleMarker([site.latitude, site.longitude], getSiteMarkerStyle(site)).addTo(state.siteMarkerLayerGroup);
    marker.bindTooltip(buildSiteTooltipHtml(site), {
      sticky: true,
      direction: "top",
      className: "site-hover-tooltip",
      opacity: 1,
    });
    marker.on("click", () => {
      handleMapSelection({ lat: site.latitude, lng: site.longitude }).catch((error) => {
        console.error(error);
        setForecastStatus("Selection failed");
        setBanner(error.message || "Unable to process the selected site.", "error");
      });
    });
  });
}

function updateSiteLabels() {
  if (!state.siteLabelLayerGroup) {
    return;
  }

  state.siteLabelLayerGroup.clearLayers();
  if (!state.map || state.map.getZoom() < SITE_LABEL_MIN_ZOOM) {
    return;
  }

  const bounds = state.map.getBounds();
  const visibleSites = state.forecastSitesWithAmplitude.filter((site) => (
    bounds.contains([site.latitude, site.longitude])
  ));

  visibleSites.forEach((site) => {
    const isValid = site.status === "ok";
    const labelText = `${site.siteCode} ${formatDisplayLength(site.predictedPosAmplitudeMeters, 2)} ${formatArrivalTime(site.predictedArrivalTimeMs)}`;
    const html = [
      `<div class="site-label-bubble${isValid ? "" : " site-label-muted"}">`,
      `<span class="site-label-dot ${isValid ? "is-valid" : "is-invalid"}"></span>`,
      `<span>${escapeHtml(labelText)}</span>`,
      "</div>",
    ].join("");

    L.marker([site.latitude, site.longitude], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "site-label-icon",
        html,
        iconAnchor: [0, 18],
      }),
    }).addTo(state.siteLabelLayerGroup);
  });
}

function renderSelectionDetails(selectionContext) {
  const { clicked, nearestSite, selection, gridForecast, weightedReturnPeriodYears } = selectionContext;
  dom.selectedGridLabel.textContent = selection ? formatGridDisplayName(selection.gridName) : "Outside PTHA";
  dom.gridEventReturnPeriodLabel.textContent = formatGridEventReturnPeriodBubble(gridForecast);
  dom.selectedPointLabel.textContent = `${clicked.lat.toFixed(4)}, ${clicked.lng.toFixed(4)}`;
  dom.nearestSiteLabel.textContent = nearestSite
    ? `${nearestSite.siteCode} (${formatDisplayLength(nearestSite.predictedPosAmplitudeMeters, 2)})`
    : "None";

  if (selection) {
    const eventLabel = Number.isFinite(weightedReturnPeriodYears)
      ? `${weightedReturnPeriodYears.toFixed(0)}-year`
      : "unavailable";
    dom.selectionTitle.textContent = `${formatGridDisplayName(selection.gridName)} Grid. Clicked ${clicked.lat.toFixed(4)}, ${clicked.lng.toFixed(4)}. Nearest site ${nearestSite.siteCode}. Site location weighted return period ${eventLabel}.`;
    return;
  }

  const eventLabel = Number.isFinite(weightedReturnPeriodYears)
    ? `${weightedReturnPeriodYears.toFixed(0)}-year`
    : "unavailable";
  dom.selectionTitle.textContent = `Outside PTHA gridded coverage. Clicked ${clicked.lat.toFixed(4)}, ${clicked.lng.toFixed(4)}. Nearest site ${nearestSite.siteCode}. Site location weighted return period ${eventLabel}.`;
}

function renderTideChart(selectionContext) {
  const { nearestSite, tideStation, tideSeries } = selectionContext;
  const arrivalTimeMs = nearestSite.predictedArrivalTimeMs;
  const amplitudeMeters = nearestSite.predictedPosAmplitudeMeters;

  const tidePoints = tideSeries.timeMs.map((timeMs, index) => ({
    x: timeMs,
    y: convertValue(tideSeries.level[index], "length"),
  }));
  const upperEnvelopePoints = tideSeries.timeMs.map((timeMs, index) => ({
    x: timeMs,
    y: timeMs >= arrivalTimeMs
      ? convertValue(tideSeries.level[index] + amplitudeMeters, "length")
      : null,
  }));
  const lowerEnvelopePoints = tideSeries.timeMs.map((timeMs, index) => ({
    x: timeMs,
    y: timeMs >= arrivalTimeMs
      ? convertValue(tideSeries.level[index] - amplitudeMeters, "length")
      : null,
  }));
  const arrivalLevel = convertValue(findNearestTideLevel(tideSeries, arrivalTimeMs), "length");

  dom.tideChartTitle.textContent = "NOAA Tide Prediction + Tsunami Envelope";
  dom.tideChartMeta.textContent = `${formatTideChartTitle(tideStation)}. Nearest site ${nearestSite.siteCode}, predicted amplitude ${formatDisplayLength(amplitudeMeters, 2)}, arrival ${formatDisplayDateTime(arrivalTimeMs)} ${getTimeModeShortLabel()}.`;

  state.tideChart.options.scales.y.title.text = `Elevation (${getUnitLabel("length")})`;
  state.tideChart.options.scales.x.title.text = `${getTimeModeAxisLabel()} time`;
  state.tideChart.options.plugins.emptyStateMessage.message = "";
  state.tideChart.options.plugins.verticalReferenceLine.value = arrivalTimeMs;
  state.tideChart.options.plugins.verticalReferenceLine.label = "Predicted arrival";
  state.tideChart.data.datasets = [
    {
      label: "Predicted Tide",
      data: tidePoints,
      borderColor: COLORS.green,
      backgroundColor: "rgba(45, 164, 78, 0.12)",
      borderWidth: 2.4,
      pointRadius: 0,
      tension: 0.2,
    },
    {
      label: "Maximum Likely Tsunami Elevation",
      data: upperEnvelopePoints,
      borderColor: COLORS.coral,
      backgroundColor: "rgba(229, 103, 82, 0.12)",
      borderWidth: 2.4,
      pointRadius: 0,
      tension: 0.18,
      spanGaps: false,
    },
    {
      label: "Minimum Likely Tsunami Elevation",
      data: lowerEnvelopePoints,
      borderColor: COLORS.blue,
      backgroundColor: "rgba(37, 99, 235, 0.12)",
      borderWidth: 2.2,
      pointRadius: 0,
      tension: 0.18,
      spanGaps: false,
    },
    {
      type: "scatter",
      label: "Predicted Arrival Time",
      data: [{ x: arrivalTimeMs, y: arrivalLevel }],
      borderColor: COLORS.gold,
      backgroundColor: COLORS.gold,
      pointRadius: 6.5,
      pointHoverRadius: 7.5,
      showLine: false,
    },
  ];
  state.tideChart.update();
}

function renderHazardChart(selectionContext) {
  const { selection } = selectionContext;

  if (!selection) {
    dom.hazardChartTitle.textContent = "Clicked-Location Event Hazard Curve";
    dom.hazardChartMeta.textContent = "No PTHA hazard curve is available outside the gridded domains.";
    state.hazardChart.options.plugins.emptyStateMessage.message = "This clicked location is outside the PTHA grids.";
    state.hazardChart.options.scales.x.min = 72;
    state.hazardChart.data.datasets = [];
    state.hazardChart.update();
    return;
  }

  const primaryCurve = [0, ...selection.primaryCurve];
  const primaryData = buildCurveDataset(EXTENDED_RETURN_PERIODS, convertCurveValues(primaryCurve, "length"));
  const eventReturnPeriodYears = Number(selection.eventReturnPeriodYears);
  const eventPrimaryValue = convertValue(selection.eventPrimaryValue, "length");
  const hasEventMarker = Number.isFinite(eventReturnPeriodYears) && Number.isFinite(eventPrimaryValue);
  const hazardCurveMinReturnPeriod = getHazardChartMinReturnPeriod(eventReturnPeriodYears);

  dom.hazardChartTitle.textContent = selection.isInitiallyWet
    ? "Maximum Tsunami Crest Elevation Hazard Curve"
    : "Maximum Tsunami Flow Depth Hazard Curve";
  dom.hazardChartMeta.textContent = Number.isFinite(eventReturnPeriodYears)
    ? `Site location weighted return period ${eventReturnPeriodYears.toFixed(0)} years (inverse-distance weighted from valid forecast sites).`
    : "No finite site location weighted return period was available.";

  state.hazardChart.options.scales.y.title.text = selection.isInitiallyWet
    ? `Maximum Tsunami Crest Elevation (${getUnitLabel("length")})`
    : `Maximum Tsunami Flow Depth (${getUnitLabel("length")})`;
  state.hazardChart.options.scales.x.min = hazardCurveMinReturnPeriod;
  state.hazardChart.options.plugins.emptyStateMessage.message = primaryCurve.some(Number.isFinite)
    ? ""
    : "No valid hazard-curve values were stored for this cell.";
  state.hazardChart.data.datasets = [
    {
      label: selection.primaryCurveLabel,
      data: primaryData,
      borderColor: COLORS.blue,
      backgroundColor: "rgba(37, 99, 235, 0.16)",
      pointBackgroundColor: COLORS.coral,
      pointBorderColor: COLORS.blue,
      pointRadius: 4.4,
      pointHoverRadius: 5.4,
      borderWidth: 2.4,
      tension: 0.16,
      spanGaps: false,
    },
  ];

  if (hasEventMarker) {
    state.hazardChart.data.datasets.push({
      type: "scatter",
      label: "Site Location Weighted Return Period",
      data: [{ x: eventReturnPeriodYears, y: eventPrimaryValue }],
      borderColor: COLORS.gold,
      backgroundColor: COLORS.gold,
      pointRadius: 7,
      pointHoverRadius: 8,
      showLine: false,
    });
  }

  state.hazardChart.update();
}

function buildTideChartOptions(emptyMessage) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "index",
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
          title: tooltipTimeTitle,
          label(context) {
            const value = context.parsed.y;
            if (!Number.isFinite(value)) {
              return `${context.dataset.label}: no data`;
            }
            return `${context.dataset.label}: ${value.toFixed(3)} ${getUnitLabel("length")}`;
          },
        },
      },
      emptyStateMessage: {
        message: emptyMessage,
      },
      verticalReferenceLine: {
        value: null,
        color: COLORS.coral,
        label: "",
      },
    },
    scales: {
      x: {
        type: "time",
        time: {
          unit: "hour",
        },
        ticks: {
          color: COLORS.slate,
          callback(value) {
            return formatAxisDate(Number(value));
          },
        },
        grid: {
          color: "rgba(17, 49, 76, 0.08)",
        },
        title: {
          display: true,
          text: `${getTimeModeAxisLabel()} time`,
          color: COLORS.navy,
          font: {
            family: "Manrope",
            weight: "700",
          },
        },
      },
      y: {
        title: {
          display: true,
          text: "Elevation (m)",
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

function buildHazardChartOptions(emptyMessage) {
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
            return items.length ? `${items[0].parsed.x.toFixed(1)}-year return period` : "";
          },
          label(context) {
            const value = context.parsed.y;
            if (!Number.isFinite(value)) {
              return `${context.dataset.label}: no data`;
            }
            return `${context.dataset.label}: ${value.toFixed(3)} ${getUnitLabel("length")}`;
          },
        },
      },
      emptyStateMessage: {
        message: emptyMessage,
      },
    },
    scales: {
      x: {
        type: "logarithmic",
        min: 72,
        max: 3500,
        afterBuildTicks(scale) {
          scale.ticks = EXTENDED_RETURN_PERIODS
            .filter((value) => value >= Number(scale.options.min))
            .map((value) => ({ value }));
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
            return EXTENDED_RETURN_PERIODS.includes(numericValue) ? String(numericValue) : "";
          },
        },
      },
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

function setUnitSystem(nextUnitSystem) {
  if (nextUnitSystem !== "metric" && nextUnitSystem !== "english") {
    return;
  }

  state.unitSystem = nextUnitSystem;
  updateUnitToggleUi();
  refreshDisplayPresentation();
}

function setTimeMode(nextTimeMode) {
  const normalized = nextTimeMode === "local" ? "local" : "utc";
  if (state.timeMode === normalized) {
    return;
  }

  state.timeMode = normalized;
  updateTimeToggleUi();
  refreshDisplayPresentation();
}

function updateUnitToggleUi() {
  dom.unitToggleButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.unitSystem === state.unitSystem);
  });
}

function updateTimeToggleUi() {
  dom.timeToggleButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.timeMode === state.timeMode);
  });
}

function refreshDisplayPresentation() {
  renderWorkbookSummary();
  updateSiteLabels();

  if (state.tideChart) {
    state.tideChart.options.scales.x.title.text = `${getTimeModeAxisLabel()} time`;
  }

  if (state.selectedSelection) {
    renderSelectionDetails(state.selectedSelection);
    renderTideChart(state.selectedSelection);
    renderHazardChart(state.selectedSelection);
    return;
  }

  if (state.tideChart) {
    state.tideChart.update();
  }
}

function showForecastDisplay() {
  dom.forecastEmptyState.classList.add("hidden");
  dom.forecastContent.classList.remove("hidden");
}

function resetSelectionDisplay() {
  state.selectedClickLatLng = null;
  state.selectedSelection = null;
  state.selectedGridName = null;

  dom.selectedGridLabel.textContent = "None";
  dom.gridEventReturnPeriodLabel.textContent = "None";
  dom.selectedPointLabel.textContent = "No point";
  dom.nearestSiteLabel.textContent = "None";
  dom.selectionTitle.textContent = "Click any map location after the scenario loads";

  updateGridHighlight();
  clearSelectionVisuals();
  resetCharts();
}

function clearSelectionVisuals() {
  if (state.selectedMarker && state.map?.hasLayer(state.selectedMarker)) {
    state.map.removeLayer(state.selectedMarker);
  }
  if (state.selectedSiteMarker && state.map?.hasLayer(state.selectedSiteMarker)) {
    state.map.removeLayer(state.selectedSiteMarker);
  }
  state.selectedMarker = null;
  state.selectedSiteMarker = null;
  state.selectedGridName = null;
  updateGridHighlight();
}

function resetCharts() {
  dom.forecastContent.classList.add("hidden");
  dom.forecastEmptyState.classList.remove("hidden");

  dom.tideChartTitle.textContent = "NOAA Tide Prediction + Tsunami Envelope";
  dom.tideChartMeta.textContent = "Awaiting map selection";
  dom.hazardChartTitle.textContent = "Clicked-Location Event Hazard Curve";
  dom.hazardChartMeta.textContent = "Awaiting map selection";

  if (state.tideChart) {
    state.tideChart.options.scales.x.title.text = `${getTimeModeAxisLabel()} time`;
    state.tideChart.options.plugins.emptyStateMessage.message = "Click any map location to load NOAA tides and the site-based tsunami envelope.";
    state.tideChart.options.plugins.verticalReferenceLine.value = null;
    state.tideChart.options.plugins.verticalReferenceLine.label = "";
    state.tideChart.data.datasets = [];
    state.tideChart.update();
  }

  if (state.hazardChart) {
    state.hazardChart.options.plugins.emptyStateMessage.message = "Click inside a PTHA grid to load the clicked-location event hazard curve.";
    state.hazardChart.data.datasets = [];
    state.hazardChart.update();
  }
}

function updateSelectedMarker(latlng) {
  const markerLatLng = [latlng.lat, latlng.lng];
  if (!state.selectedMarker) {
    state.selectedMarker = L.circleMarker(markerLatLng, {
      radius: 7,
      weight: 2,
      color: COLORS.coral,
      fillColor: COLORS.gold,
      fillOpacity: 0.95,
    }).addTo(state.map);
  } else {
    state.selectedMarker.setLatLng(markerLatLng);
  }
}

function updateSelectedSiteMarker(site) {
  if (!site) {
    if (state.selectedSiteMarker && state.map?.hasLayer(state.selectedSiteMarker)) {
      state.map.removeLayer(state.selectedSiteMarker);
    }
    state.selectedSiteMarker = null;
    return;
  }

  const markerLatLng = [site.latitude, site.longitude];
  if (!state.selectedSiteMarker) {
    state.selectedSiteMarker = L.circleMarker(markerLatLng, {
      radius: 8,
      weight: 2.5,
      color: COLORS.aqua,
      fillColor: "#ffffff",
      fillOpacity: 0.92,
    }).addTo(state.map);
  } else {
    state.selectedSiteMarker.setLatLng(markerLatLng);
  }
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

function getSiteMarkerStyle(site) {
  if (site.status === "ok") {
    return {
      radius: 4.8,
      weight: 1.6,
      color: COLORS.navy,
      fillColor: COLORS.aqua,
      fillOpacity: 0.92,
    };
  }

  return {
    radius: 4.1,
    weight: 1.3,
    color: COLORS.silver,
    fillColor: "#ffffff",
    fillOpacity: 0.72,
  };
}

async function fetchCaliforniaTideStations() {
  const csvText = await fetchText(NOAA_STATIONS_CSV_URL);
  return parseCsv(csvText)
    .map((row) => normalizeTideStation({
      id: row["Station Number"],
      name: row["Station Name"],
      lat: row["Station Latitude"],
      lng: row["Station Longitude"],
    }))
    .filter(Boolean);
}

async function resolveTideStation(latlng) {
  const stations = await state.tideStationsPromise;
  if (!stations.length) {
    throw new Error("No NOAA tide stations were available.");
  }
  return findNearestSite(latlng, stations);
}

async function loadTideSeries(stationId, startMs, endMs) {
  const cacheKey = `${stationId}:${startMs}:${endMs}`;
  if (state.tideCache.has(cacheKey)) {
    return state.tideCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    begin_date: formatNoaaDate(startMs),
    end_date: formatNoaaDate(endMs),
    station: stationId,
    product: "predictions",
    datum: "MLLW",
    interval: "h",
    units: "metric",
    time_zone: "gmt",
    format: "json",
    application: NOAA_APPLICATION_ID,
  });

  const requestUrl = `${NOAA_PREDICTIONS_URL}?${params.toString()}`;
  const response = await fetch(requestUrl);
  if (!response.ok) {
    throw new Error(`NOAA tide request failed with ${response.status}.`);
  }

  const payload = await response.json();
  if (!payload.predictions) {
    throw new Error(payload.error?.message || "NOAA tide payload did not include predictions.");
  }

  const tideSeries = {
    stationId,
    timeMs: payload.predictions.map((row) => Date.parse(`${row.t}Z`)),
    level: payload.predictions.map((row) => Number(row.v)),
  };
  state.tideCache.set(cacheKey, tideSeries);
  return tideSeries;
}

function findNearestTideLevel(tideSeries, targetMs) {
  if (!tideSeries.timeMs.length) {
    return 0;
  }

  let bestIndex = 0;
  let bestDelta = Math.abs(tideSeries.timeMs[0] - targetMs);
  for (let index = 1; index < tideSeries.timeMs.length; index += 1) {
    const delta = Math.abs(tideSeries.timeMs[index] - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  }
  return tideSeries.level[bestIndex];
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
  manifest.gridGeometry.westEdgeLongitude180 = Number(manifest.gridGeometry.westEdgeLongitude180);
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
  const cacheKey = `${relativeBinaryPath}:${byteOffset}`;
  if (state.recordCache.has(cacheKey)) {
    return state.recordCache.get(cacheKey);
  }

  const request = (async () => {
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
  })();

  state.recordCache.set(cacheKey, request);
  try {
    const record = await request;
    state.recordCache.set(cacheKey, record);
    return record;
  } catch (error) {
    state.recordCache.delete(cacheKey);
    throw error;
  }
}

function decodeLookupRecord(record) {
  return {
    topo: sanitizeTopoValue(record[0]),
    flowDepth: sanitizeHazardCurve(record.slice(1, 8)),
    sourceAmplitude: sanitizeHazardCurve(record.slice(15, 22)),
    velocity: sanitizeHazardCurve(record.slice(22, 29)),
    momentumFlux: sanitizeHazardCurve(record.slice(29, 36)),
    isInitiallyWet: Number.isFinite(record[0]) && record[0] < 0,
  };
}

function findContainingGrid(latlng) {
  const containingGrids = state.index.grids.filter((grid) => containsLatLng(latlng, grid.bounds180));
  if (!containingGrids.length) {
    return null;
  }
  return containingGrids.sort((left, right) => left.area - right.area)[0];
}

function findNearestSite(target, sites) {
  if (!sites?.length) {
    return null;
  }

  let bestSite = sites[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  sites.forEach((site) => {
    const distance = haversineKm(target.lat, target.lng, site.latitude ?? site.lat, site.longitude ?? site.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSite = site;
    }
  });
  return bestSite;
}

function computeSiteLocationWeightedReturnPeriod(target, sites) {
  const validSites = (sites || []).filter((site) => Number.isFinite(site.eventReturnPeriodYears));
  if (!validSites.length) {
    return NaN;
  }

  const coincidentSites = validSites.filter((site) => (
    haversineKm(target.lat, target.lng, site.latitude ?? site.lat, site.longitude ?? site.lng) < 1e-6
  ));
  if (coincidentSites.length) {
    return mean(coincidentSites.map((site) => site.eventReturnPeriodYears));
  }

  let weightedSum = 0;
  let weightTotal = 0;

  validSites.forEach((site) => {
    const distanceKm = haversineKm(target.lat, target.lng, site.latitude ?? site.lat, site.longitude ?? site.lng);
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      return;
    }

    const weight = 1 / distanceKm;
    weightedSum += site.eventReturnPeriodYears * weight;
    weightTotal += weight;
  });

  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    return NaN;
  }

  return weightedSum / weightTotal;
}

function interpolateReturnPeriodFromAmplitude(curveValues, predictedAmplitudeMeters) {
  if (!Number.isFinite(predictedAmplitudeMeters)) {
    return NaN;
  }
  if (predictedAmplitudeMeters <= 0) {
    return 1;
  }

  const finitePairs = EXTENDED_RETURN_PERIODS
    .map((returnPeriodYears, index) => ({
      returnPeriodYears,
      amplitudeMeters: curveValues[index],
    }))
    .filter((pair) => Number.isFinite(pair.amplitudeMeters));

  if (finitePairs.length < 2) {
    return NaN;
  }

  if (predictedAmplitudeMeters > finitePairs.at(-1).amplitudeMeters) {
    return NaN;
  }

  for (let index = 0; index < finitePairs.length - 1; index += 1) {
    const left = finitePairs[index];
    const right = finitePairs[index + 1];
    if (predictedAmplitudeMeters < left.amplitudeMeters || predictedAmplitudeMeters > right.amplitudeMeters) {
      continue;
    }

    if (right.amplitudeMeters === left.amplitudeMeters) {
      return right.returnPeriodYears;
    }

    const fraction = (predictedAmplitudeMeters - left.amplitudeMeters) / (right.amplitudeMeters - left.amplitudeMeters);
    return left.returnPeriodYears + fraction * (right.returnPeriodYears - left.returnPeriodYears);
  }

  return NaN;
}

function interpolateCurveValueAtReturnPeriod(curveValues, targetReturnPeriodYears) {
  if (!Number.isFinite(targetReturnPeriodYears)) {
    return NaN;
  }

  const finitePairs = EXTENDED_RETURN_PERIODS
    .map((returnPeriodYears, index) => ({
      returnPeriodYears,
      curveValue: curveValues[index],
    }))
    .filter((pair) => Number.isFinite(pair.curveValue));

  if (finitePairs.length < 2) {
    return NaN;
  }

  if (targetReturnPeriodYears < finitePairs[0].returnPeriodYears || targetReturnPeriodYears > finitePairs.at(-1).returnPeriodYears) {
    return NaN;
  }

  for (let index = 0; index < finitePairs.length - 1; index += 1) {
    const left = finitePairs[index];
    const right = finitePairs[index + 1];
    if (targetReturnPeriodYears < left.returnPeriodYears || targetReturnPeriodYears > right.returnPeriodYears) {
      continue;
    }

    if (right.returnPeriodYears === left.returnPeriodYears) {
      return right.curveValue;
    }

    const fraction = (targetReturnPeriodYears - left.returnPeriodYears) / (right.returnPeriodYears - left.returnPeriodYears);
    return left.curveValue + fraction * (right.curveValue - left.curveValue);
  }

  return NaN;
}

function buildPrimaryCurve({ isInitiallyWet, flowDepth, sourceAmplitude }) {
  return isInitiallyWet ? sourceAmplitude : flowDepth;
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

function sanitizeHazardValue(value) {
  if (Number.isFinite(value)) {
    return value <= -9990 ? NaN : value;
  }
  return NaN;
}

function shouldRenderInundationOverlays() {
  return Boolean(state.map) && state.map.getZoom() >= (state.map.getMaxZoom() - INUNDATION_ZOOM_LEVELS_FROM_MAX);
}

function showInundationLegend(periodsShown) {
  dom.inundationLegendList.innerHTML = periodsShown.map((returnPeriodYears) => `
    <li>
      <span class="legend-swatch" style="border-top-color:${INUNDATION_COLORS.get(returnPeriodYears) || COLORS.coral}"></span>
      <span>${returnPeriodYears}-year</span>
    </li>
  `).join("");
  dom.inundationLegend.classList.remove("hidden");
  state.inundationLegendVisible = true;
}

function hideInundationLegend() {
  if (!dom.inundationLegend) {
    return;
  }
  dom.inundationLegend.classList.add("hidden");
  dom.inundationLegendList.innerHTML = "";
  state.inundationLegendVisible = false;
}

function buildCurveDataset(returnPeriods, values) {
  return returnPeriods.map((returnPeriodYears, index) => ({
    x: returnPeriodYears,
    y: Number.isFinite(values[index]) ? values[index] : null,
  }));
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

  if (quantity === "length") {
    return value * FEET_PER_METER;
  }

  return value;
}

function getUnitLabel(quantity) {
  if (quantity !== "length") {
    return "";
  }
  return state.unitSystem === "english" ? "ft" : "m";
}

function getHazardChartMinReturnPeriod(eventReturnPeriodYears) {
  if (!Number.isFinite(eventReturnPeriodYears)) {
    return 72;
  }
  return clamp(eventReturnPeriodYears, 1, 72);
}

function formatGridEventReturnPeriodBubble(gridForecast) {
  if (!Number.isFinite(gridForecast?.eventReturnPeriodYears)) {
    return "None";
  }

  if (gridForecast.source === "mean_in_grid") {
    return `${gridForecast.eventReturnPeriodYears.toFixed(0)} yr avg`;
  }

  if (gridForecast.source === "nearest_site" && gridForecast.sourceSites?.length) {
    return `${gridForecast.eventReturnPeriodYears.toFixed(0)} yr via ${gridForecast.sourceSites[0]}`;
  }

  return `${gridForecast.eventReturnPeriodYears.toFixed(0)} yr`;
}

function tooltipTimeTitle(items) {
  if (!items.length) {
    return "";
  }
  return `${formatDisplayDateTime(items[0].parsed.x)} ${getTimeModeShortLabel()}`;
}

function buildSiteTooltipHtml(site) {
  const amplitudeText = Number.isFinite(site.predictedPosAmplitudeMeters)
    ? formatDisplayLength(site.predictedPosAmplitudeMeters, 2)
    : "Amplitude unavailable";
  const arrivalText = Number.isFinite(site.predictedArrivalTimeMs)
    ? formatArrivalTime(site.predictedArrivalTimeMs)
    : "Arrival unavailable";
  const gridText = site.gridName ? formatGridDisplayName(site.gridName) : "Outside PTHA grids";
  return [
    `<strong>${escapeHtml(site.siteCode)} - ${escapeHtml(site.siteName)}</strong>`,
    `<div class="site-hover-meta">${escapeHtml(amplitudeText)} · ${escapeHtml(arrivalText)} · ${escapeHtml(gridText)}</div>`,
  ].join("");
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
    grids,
  };
}

function countFiniteGridForecasts() {
  return Array.from(state.gridForecasts.values()).filter((gridForecast) => (
    Number.isFinite(gridForecast.eventReturnPeriodYears)
  )).length;
}

function parseWorkbookNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseWorkbookUtcTimestamp(value) {
  if (!value) {
    return NaN;
  }

  const normalized = String(value).trim().replace(" UTC", "Z").replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeTideStation(rawStation) {
  const id = String(rawStation.id ?? "").trim();
  const name = String(rawStation.name ?? "").trim();
  const lat = Number(rawStation.lat);
  const lng = Number(rawStation.lng);
  if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return { id, name, lat, lng };
}

function formatTideChartTitle(station) {
  if (!station?.id) {
    return "NOAA Tide Prediction";
  }
  return station.name
    ? `NOAA Tide Prediction - Station ${station.id}, ${station.name}`
    : `NOAA Tide Prediction - Station ${station.id}`;
}

function formatDisplayLength(valueMeters, digits = 2) {
  if (!Number.isFinite(valueMeters)) {
    return "NaN";
  }
  return `${convertValue(valueMeters, "length").toFixed(digits)} ${getUnitLabel("length")}`;
}

function formatArrivalTime(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return "Arrival unavailable";
  }
  return `${formatDisplayTime(timeMs)} ${getTimeModeShortLabel()}`;
}

function getTimeModeAxisLabel() {
  return state.timeMode === "local" ? "Local" : "UTC";
}

function getTimeModeShortLabel() {
  return state.timeMode === "local" ? "Local" : "UTC";
}

function getDisplayTimeZone() {
  return state.timeMode === "utc" ? "UTC" : undefined;
}

function formatDisplayDateTime(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return "--";
  }
  return new Date(timeMs).toLocaleString("en-US", {
    timeZone: getDisplayTimeZone(),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(",", "");
}

function formatDisplayTime(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return "";
  }
  return new Date(timeMs).toLocaleTimeString("en-US", {
    timeZone: getDisplayTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatAxisDate(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return "";
  }
  return [
    new Date(timeMs).toLocaleDateString("en-US", {
      timeZone: getDisplayTimeZone(),
      month: "short",
      day: "numeric",
    }),
    new Date(timeMs).toLocaleTimeString("en-US", {
      timeZone: getDisplayTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  ];
}

function formatNoaaDate(timeMs) {
  const date = new Date(timeMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function setForecastStatus(message) {
  void message;
}

function setTopbarWorkbookStatus(message) {
  dom.topbarWorkbookStatus.textContent = message;
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

function fetchJSON(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed for ${url} with status ${response.status}`);
    }
    return response.json();
  });
}

function fetchText(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed for ${url} with status ${response.status}`);
    }
    return response.text();
  });
}

function parseCsv(text) {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  const lines = trimmedText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function parseCsvLine(line) {
  const values = [];
  let currentValue = "";
  let isInsideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === "\"") {
      if (isInsideQuotes && nextCharacter === "\"") {
        currentValue += "\"";
        index += 1;
      } else {
        isInsideQuotes = !isInsideQuotes;
      }
      continue;
    }

    if (character === "," && !isInsideQuotes) {
      values.push(currentValue.trim());
      currentValue = "";
      continue;
    }

    currentValue += character;
  }

  values.push(currentValue.trim());
  return values;
}

async function mapWithConcurrency(items, limit, mapper, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      completed += 1;
      if (onProgress) {
        onProgress(completed, items.length);
      }
    }
  });

  await Promise.all(workers);
  return results;
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

function containsLatLng(latlng, bounds180) {
  return latlng.lat >= Number(bounds180.minLatitude) &&
    latlng.lat <= Number(bounds180.maxLatitude) &&
    latlng.lng >= Number(bounds180.minLongitude) &&
    latlng.lng <= Number(bounds180.maxLongitude);
}

function intersectsMapBounds(mapBounds, bounds180) {
  return mapBounds.intersects(L.latLngBounds(toLeafletBounds(bounds180)));
}

function toLeafletBounds(bounds180) {
  return [
    [Number(bounds180.minLatitude), Number(bounds180.minLongitude)],
    [Number(bounds180.maxLatitude), Number(bounds180.maxLongitude)],
  ];
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

function mean(values) {
  if (!values?.length) {
    return NaN;
  }
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) {
    return NaN;
  }
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
    inundationRoot: normalizeDataRoot(inundationQueryValue || inundationGlobalValue || sharedValue || "./inundation_limits"),
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
