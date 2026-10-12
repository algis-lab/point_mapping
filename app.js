(function () {
  'use strict';

  const STORE_KEY = 'pointMapping.features.v1';
  const VIEW_KEY = 'pointMapping.view.v1';
  const LABELS_KEY = 'pointMapping.labels.v1';
  const THEME_KEY = 'pointMapping.dark.v1';
  const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e88e5', '#5e35b1', '#d81b60', '#6d4c41', '#37474f'];
  const DEFAULT_VIEW = { center: [12.8797, 121.774], zoom: 6 };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- storage
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      toast('Could not save to browser storage. Export your data to keep it.');
    }
  }

  // features: { id, type: 'point' | 'line', name, notes, color, coords }
  // coords is [lat, lng] for a point and [[lat, lng], ...] for a line.
  let features = load(STORE_KEY, []);
  const layers = new Map();
  let selectedId = null;
  let showLabels = load(LABELS_KEY, false);

  const saveFeatures = () => store(STORE_KEY, features);
  const byId = (id) => features.find((f) => f.id === id);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // -------------------------------------------------------------------- map
  const view = load(VIEW_KEY, DEFAULT_VIEW);
  const map = L.map('map', { maxZoom: 20 }).setView(view.center, view.zoom);

  const baseLayers = {
    'Street (OSM)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 19, className: 'dimmable',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }),
    'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
    }),
    'Topographic (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, className: 'dimmable',
      attribution: 'Tiles &copy; Esri'
    })
  };
  baseLayers['Street (OSM)'].addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

  // ------------------------------------------------------------- night mode
  // The street and topo basemaps are darkened in CSS (.dimmable); satellite is left as is.
  function setTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('btnTheme').title = dark ? 'Switch to day mode' : 'Switch to night mode';
    $('themeLabel').textContent = dark ? 'Day mode' : 'Night mode';
  }

  setTheme(load(THEME_KEY, window.matchMedia('(prefers-color-scheme: dark)').matches));
  $('btnTheme').onclick = () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    store(THEME_KEY, dark);
    setTheme(dark);
  };
  L.control.scale({ imperial: false }).addTo(map);

  const featureGroup = L.featureGroup().addTo(map);
  const editGroup = L.layerGroup().addTo(map);
  const draftGroup = L.layerGroup().addTo(map);

  map.on('moveend', () => {
    const c = map.getCenter();
    store(VIEW_KEY, { center: [c.lat, c.lng], zoom: map.getZoom() });
  });

  // ---------------------------------------------------------------- helpers
  const fmtCoord = (ll) => ll[0].toFixed(6) + ', ' + ll[1].toFixed(6);

  function lineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += map.distance(coords[i - 1], coords[i]);
    return total;
  }

  function fmtLength(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(1) + ' m';
  }

  const describe = (f) => f.type === 'point'
    ? fmtCoord(f.coords)
    : fmtLength(lineLength(f.coords)) + ' · ' + f.coords.length + ' vertices';

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  function el(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => node.append(c));
    return node;
  }

  function pinIcon(color, selected) {
    return L.divIcon({
      className: 'pin' + (selected ? ' selected' : ''),
      html: '<svg width="26" height="36" viewBox="0 0 26 36"><path d="M13 35S2 21.5 2 13a11 11 0 0 1 22 0c0 8.500-11 22-11 22z" fill="' + color +
        '" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4" fill="#fff"/></svg>',
      iconSize: [26, 36],
      iconAnchor: [13, 35],
      popupAnchor: [0, -32],
      tooltipAnchor: [0, -34]
    });
  }

  const dotIcon = (cls, size) => L.divIcon({ className: cls, html: '<div></div>', iconSize: [size, size] });

  // ------------------------------------------------------ feature rendering
  function renderFeature(f) {
    const old = layers.get(f.id);
    if (old) featureGroup.removeLayer(old);

    const selected = f.id === selectedId;
    let layer;
    if (f.type === 'point') {
      layer = L.marker(f.coords, { icon: pinIcon(f.color, selected), draggable: selected, zIndexOffset: selected ? 500 : 0 });
      layer.on('dragend', () => {
        const ll = layer.getLatLng();
        f.coords = [ll.lat, ll.lng];
        saveFeatures();
        renderList();
        layer.setPopupContent(popupContent(f));
      });
    } else {
      layer = L.polyline(f.coords, {
        color: f.color, weight: selected ? 6 : 4, opacity: 0.9, bubblingMouseEvents: false
      });
    }

    layer.bindPopup(() => popupContent(f), { minWidth: 180 });
    layer.bindTooltip(f.name, {
      permanent: showLabels, direction: 'top', className: 'feature-label',
      offset: f.type === 'line' ? [0, -6] : [0, 0]
    });
    // Popups only open through select(), so drawing over a feature is not interrupted.
    layer.off('click');
    layer.on('click', (e) => {
      if (tool === 'select') select(f.id, e.latlng);
      else onMapClick({ latlng: e.latlng });
    });

    layers.set(f.id, layer);
    featureGroup.addLayer(layer);
    return layer;
  }

  function popupContent(f) {
    const edit = el('button', { className: 'btn small', textContent: 'Edit' });
    const zoom = el('button', { className: 'btn small', textContent: 'Zoom to' });
    const del = el('button', { className: 'btn small danger', textContent: 'Delete' });
    edit.onclick = () => openDialog(f.id);
    zoom.onclick = () => zoomTo(f);
    del.onclick = () => {
      if (confirm('Delete "' + f.name + '"?')) removeFeature(f.id);
    };

    const parts = [el('h4', { textContent: f.name })];
    if (f.notes) parts.push(el('p', { textContent: f.notes }));
    parts.push(el('p', { className: 'meta', textContent: describe(f) }));
    parts.push(el('div', { className: 'actions' }, [edit, zoom, del]));
    return el('div', { className: 'popup' }, parts);
  }

  function zoomTo(f) {
    if (f.type === 'point') map.setView(f.coords, Math.max(map.getZoom(), 17));
    else map.fitBounds(L.latLngBounds(f.coords), { padding: [40, 40], maxZoom: 18 });
  }

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('featureList');
    list.replaceChildren();

    features.filter((f) => !q || f.name.toLowerCase().includes(q)).forEach((f) => {
      const sym = el('span', { className: 'sym' });
      sym.innerHTML = f.type === 'point'
        ? '<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="' + f.color + '" stroke="#fff" stroke-width="2"/></svg>'
        : '<svg viewBox="0 0 18 18"><path d="M2 14l5-8 4 5 5-8" fill="none" stroke="' + f.color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const txt = el('div', { className: 'txt' }, [
        el('div', { className: 'name', textContent: f.name }),
        el('div', { className: 'sub', textContent: describe(f) })
      ]);
      const li = el('li', { className: f.id === selectedId ? 'selected' : '' }, [sym, txt]);
      li.onclick = () => {
        setTool('select');
        zoomTo(f);
        select(f.id);
        if (window.matchMedia('(max-width: 860px)').matches) $('sidebar').classList.add('collapsed');
      };
      list.append(li);
    });

    $('featureCount').textContent = features.length;
    $('emptyMsg').hidden = features.length > 0;
    list.hidden = features.length === 0;
  }

  // -------------------------------------------------------------- selection
  function select(id, latlng) {
    const f = byId(id);
    if (!f) return;
    if (selectedId !== id) {
      deselect();
      selectedId = id;
      renderFeature(f);
      if (f.type === 'line') showHandles(f);
      renderList();
    }
    const layer = layers.get(id);
    if (f.type === 'point') layer.openPopup();
    else layer.openPopup(latlng || f.coords[Math.floor(f.coords.length / 2)]);
  }

  function deselect() {
    if (!selectedId) return;
    const f = byId(selectedId);
    selectedId = null;
    editGroup.clearLayers();
    map.closePopup();
    if (f) renderFeature(f);
    renderList();
  }

  // Draggable vertex handles for the selected line, plus midpoint handles to insert vertices.
  function showHandles(f) {
    editGroup.clearLayers();
    const line = layers.get(f.id);
    const changed = () => {
      saveFeatures();
      renderList();
      showHandles(f);
    };

    f.coords.forEach((c, i) => {
      const h = L.marker(c, { icon: dotIcon('vertex', 14), draggable: true, zIndexOffset: 1000 });
      h.on('dragstart', () => map.closePopup());
      h.on('drag', () => {
        const ll = h.getLatLng();
        f.coords[i] = [ll.lat, ll.lng];
        line.setLatLngs(f.coords);
      });
      h.on('dragend', changed);
      h.on('contextmenu', () => {
        if (f.coords.length <= 2) return toast('A polyline needs at least 2 vertices.');
        f.coords.splice(i, 1);
        line.setLatLngs(f.coords);
        changed();
      });
      editGroup.addLayer(h);

      if (i < f.coords.length - 1) {
        const n = f.coords[i + 1];
        const mid = [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2];
        const m = L.marker(mid, { icon: dotIcon('midpoint', 10), zIndexOffset: 900, title: 'Click to add a vertex here' });
        m.on('click', () => {
          f.coords.splice(i + 1, 0, mid);
          line.setLatLngs(f.coords);
          changed();
        });
        editGroup.addLayer(m);
      }
    });
  }

  // ------------------------------------------------------------ feature CRUD
  function addFeature(type, coords) {
    const n = features.filter((f) => f.type === type).length + 1;
    const f = {
      id: uid(),
      type: type,
      name: (type === 'point' ? 'Point ' : 'Line ') + n,
      notes: '',
      color: type === 'point' ? COLORS[0] : COLORS[5],
      coords: coords
    };
    features.push(f);
    saveFeatures();
    renderFeature(f);
    renderList();
    openDialog(f.id, true);
    return f;
  }

  function removeFeature(id) {
    if (selectedId === id) deselect();
    const layer = layers.get(id);
    if (layer) featureGroup.removeLayer(layer);
    layers.delete(id);
    features = features.filter((f) => f.id !== id);
    saveFeatures();
    renderList();
  }

  // ----------------------------------------------------------------- dialog
  const dialog = $('featureDialog');
  let dialogId = null;
  let dialogColor = COLORS[0];

  COLORS.forEach((c) => {
    const b = el('button', { type: 'button', title: c });
    b.style.background = c;
    b.dataset.color = c;
    b.onclick = () => setDialogColor(c);
    $('fColors').append(b);
  });

  function setDialogColor(c) {
    dialogColor = c;
    $('fColors').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
  }

  function openDialog(id, isNew) {
    const f = byId(id);
    if (!f) return;
    dialogId = id;
    map.closePopup();
    $('dlgTitle').textContent = (isNew ? 'New ' : 'Edit ') + (f.type === 'point' ? 'point' : 'polyline');
    $('fName').value = f.name;
    $('fNotes').value = f.notes;
    $('fInfo').textContent = describe(f);
    setDialogColor(f.color);
    dialog.showModal();
    $('fName').select();
  }

  $('dlgCancel').onclick = () => dialog.close();
  $('featureForm').addEventListener('submit', () => {
    const f = byId(dialogId);
    if (!f) return;
    f.name = $('fName').value.trim() || f.name;
    f.notes = $('fNotes').value.trim();
    f.color = dialogColor;
    saveFeatures();
    renderFeature(f);
    if (f.id === selectedId && f.type === 'line') showHandles(f);
    renderList();
  });

  // ------------------------------------------------------------------ tools
  let tool = 'select';
  let draft = null; // in-progress polyline: { coords, line, guide }

  function setTool(next) {
    if (tool === next) return;
    discardDraft();
    tool = next;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $('map').classList.toggle('drawing', tool !== 'select');
    if (tool === 'select') map.doubleClickZoom.enable();
    else {
      map.doubleClickZoom.disable();
      deselect();
    }
    if (tool === 'line') startDraft();
    updateDrawBar();
  }

  function updateDrawBar() {
    $('drawBar').hidden = tool === 'select';
    $('drawActions').hidden = tool !== 'line';
    if (tool === 'point') {
      $('drawHint').textContent = 'Click the map to add a point.';
    } else if (tool === 'line') {
      const n = draft.coords.length;
      $('drawHint').textContent = n === 0
        ? 'Click the map to start the polyline.'
        : n + (n === 1 ? ' vertex' : ' vertices') + ' · ' + fmtLength(lineLength(draft.coords));
      $('btnUndo').disabled = n === 0;
      $('btnFinish').disabled = n < 2;
    }
  }

  function startDraft() {
    draft = {
      coords: [],
      line: L.polyline([], { color: COLORS[5], weight: 4, interactive: false }),
      guide: L.polyline([], { color: COLORS[5], weight: 2, dashArray: '6 6', interactive: false })
    };
    draftGroup.addLayer(draft.line).addLayer(draft.guide);
  }

  function discardDraft() {
    draftGroup.clearLayers();
    draft = null;
  }

  function redrawDraft() {
    draftGroup.clearLayers();
    draft.line.setLatLngs(draft.coords);
    draft.guide.setLatLngs([]);
    draftGroup.addLayer(draft.line).addLayer(draft.guide);
    draft.coords.forEach((c) => {
      draftGroup.addLayer(L.circleMarker(c, {
        radius: 5, color: COLORS[5], weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false
      }));
    });
    updateDrawBar();
  }

  function addVertex(latlng) {
    const last = draft.coords[draft.coords.length - 1];
    // Ignore the second click of a double-click (and accidental double taps).
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(latlng)) < 4) return;
    draft.coords.push([latlng.lat, latlng.lng]);
    redrawDraft();
  }

  function undoVertex() {
    if (!draft || !draft.coords.length) return;
    draft.coords.pop();
    redrawDraft();
  }

  function finishLine() {
    if (!draft) return;
    if (draft.coords.length < 2) return toast('Add at least 2 vertices before finishing.');
    const coords = draft.coords;
    setTool('select');
    addFeature('line', coords);
  }

  function onMapClick(e) {
    if (tool === 'point') addFeature('point', [e.latlng.lat, e.latlng.lng]);
    else if (tool === 'line') addVertex(e.latlng);
    else deselect();
  }

  map.on('click', onMapClick);
  map.on('dblclick', () => { if (tool === 'line') finishLine(); });
  map.on('mousemove', (e) => {
    $('cursorPos').textContent = fmtCoord([e.latlng.lat, e.latlng.lng]);
    if (draft && draft.coords.length) draft.guide.setLatLngs([draft.coords[draft.coords.length - 1], e.latlng]);
  });

  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool === tool ? 'select' : b.dataset.tool);
  });
  $('btnUndo').onclick = undoVertex;
  $('btnFinish').onclick = finishLine;
  $('btnCancel').onclick = () => setTool('select');

  document.addEventListener('keydown', (e) => {
    if (dialog.open || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Escape') {
      if (tool === 'select') deselect();
      else setTool('select');
    } else if (tool === 'line' && e.key === 'Enter') {
      finishLine();
    } else if (tool === 'line' && (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)))) {
      e.preventDefault();
      undoVertex();
    } else if (tool === 'select' && selectedId && e.key === 'Delete') {
      const f = byId(selectedId);
      if (confirm('Delete "' + f.name + '"?')) removeFeature(f.id);
    }
  });

  // -------------------------------------------------------------------- GPS
  const GPS_OPTS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };
  const gps = { watchId: null, following: false, fix: null, marker: null, circle: null };

  function gpsAvailable() {
    if (!('geolocation' in navigator)) {
      toast('This browser does not support GPS location.');
      return false;
    }
    if (!window.isSecureContext) {
      toast('GPS needs a secure page. Open the app over https:// or http://localhost.', 6000);
      return false;
    }
    return true;
  }

  function gpsError(err) {
    const msg = err.code === 1 ? 'Location permission was denied. Allow it in the browser site settings.'
      : err.code === 2 ? 'Your location is unavailable. Check that GPS / location services are on.'
      : 'Timed out waiting for a GPS fix. Try again with a clearer view of the sky.';
    toast(msg, 6000);
    if (err.code === 1) stopGps();
    else if (!gps.fix) $('gpsStatus').textContent = 'GPS: no fix';
  }

  function onFix(pos) {
    const first = !gps.fix;
    gps.fix = { latlng: [pos.coords.latitude, pos.coords.longitude], accuracy: pos.coords.accuracy };
    if (gps.watchId === null) return;

    if (!gps.marker) {
      gps.circle = L.circle(gps.fix.latlng, {
        radius: gps.fix.accuracy, color: '#1e88e5', weight: 1, fillOpacity: 0.12, interactive: false
      }).addTo(map);
      gps.marker = L.marker(gps.fix.latlng, {
        icon: dotIcon('gps-dot', 16), interactive: false, keyboard: false, zIndexOffset: 2000
      }).addTo(map);
    } else {
      gps.marker.setLatLng(gps.fix.latlng);
      gps.circle.setLatLng(gps.fix.latlng).setRadius(gps.fix.accuracy);
    }

    $('gpsStatus').textContent = 'GPS ' + fmtCoord(gps.fix.latlng) + ' ±' + Math.round(gps.fix.accuracy) + ' m';
    if (gps.following) map.setView(gps.fix.latlng, first ? Math.max(map.getZoom(), 17) : map.getZoom());
  }

  function startGps() {
    if (!gpsAvailable()) return;
    gps.following = true;
    gps.watchId = navigator.geolocation.watchPosition(onFix, gpsError, GPS_OPTS);
    $('gpsStatus').textContent = 'GPS: locating…';
    updateLocateButton();
  }

  function stopGps() {
    if (gps.watchId !== null) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null;
    gps.following = false;
    gps.fix = null;
    if (gps.marker) map.removeLayer(gps.marker);
    if (gps.circle) map.removeLayer(gps.circle);
    gps.marker = gps.circle = null;
    $('gpsStatus').textContent = 'GPS off';
    updateLocateButton();
  }

  function updateLocateButton() {
    const b = $('btnLocate');
    b.classList.toggle('following', gps.watchId !== null && gps.following);
    b.classList.toggle('tracking', gps.watchId !== null && !gps.following);
    b.title = gps.watchId === null ? 'Show my GPS location'
      : gps.following ? 'Following your location. Click to turn GPS off.'
      : 'Click to re-center on your location';
  }

  // Off -> following -> (user pans the map: tracking only) -> following -> off
  $('btnLocate').onclick = () => {
    if (gps.watchId === null) return startGps();
    if (gps.following) return stopGps();
    gps.following = true;
    if (gps.fix) map.setView(gps.fix.latlng, Math.max(map.getZoom(), 17));
    updateLocateButton();
  };

  map.on('dragstart', () => {
    if (gps.following) {
      gps.following = false;
      updateLocateButton();
    }
  });

  function useGpsFix(fix) {
    const latlng = L.latLng(fix.latlng);
    if (tool === 'line') {
      addVertex(latlng);
      map.panTo(latlng);
    } else {
      map.setView(latlng, Math.max(map.getZoom(), 17));
      addFeature('point', fix.latlng.slice());
    }
    if (fix.accuracy > 30) toast('GPS accuracy is low (±' + Math.round(fix.accuracy) + ' m).');
  }

  $('btnGpsPoint').onclick = () => {
    if (!gpsAvailable()) return;
    if (gps.fix) return useGpsFix(gps.fix);
    toast('Getting your GPS location…');
    navigator.geolocation.getCurrentPosition((pos) => {
      onFix(pos);
      useGpsFix(gps.fix);
      if (gps.watchId === null) gps.fix = null;
    }, gpsError, GPS_OPTS);
  };

  // --------------------------------------------------------- import / export
  function toGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature',
        properties: { name: f.name, notes: f.notes, color: f.color },
        geometry: f.type === 'point'
          ? { type: 'Point', coordinates: [f.coords[1], f.coords[0]] }
          : { type: 'LineString', coordinates: f.coords.map((c) => [c[1], c[0]]) }
      }))
    };
  }

  $('btnExport').onclick = () => {
    if (!features.length) return toast('Nothing to export yet.');
    const blob = new Blob([JSON.stringify(toGeoJSON(), null, 2)], { type: 'application/geo+json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'point-mapping-' + new Date().toISOString().slice(0, 10) + '.geojson' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const validPos = (c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180;

  function importGeoJSON(data) {
    const items = data.type === 'FeatureCollection' ? data.features
      : data.type === 'Feature' ? [data]
      : [{ type: 'Feature', properties: {}, geometry: data }];
    let added = 0;
    let skipped = 0;

    (items || []).forEach((item) => {
      const g = item && item.geometry;
      const p = (item && item.properties) || {};
      const parts = !g ? []
        : g.type === 'Point' ? [['point', g.coordinates]]
        : g.type === 'MultiPoint' ? g.coordinates.map((c) => ['point', c])
        : g.type === 'LineString' ? [['line', g.coordinates]]
        : g.type === 'MultiLineString' ? g.coordinates.map((c) => ['line', c])
        : [];
      if (!parts.length) skipped++;

      parts.forEach(([type, coords]) => {
        const ok = type === 'point' ? validPos(coords) : Array.isArray(coords) && coords.length >= 2 && coords.every(validPos);
        if (!ok) return skipped++;
        const n = features.filter((f) => f.type === type).length + 1;
        features.push({
          id: uid(),
          type: type,
          name: String(p.name || p.Name || p.title || (type === 'point' ? 'Point ' : 'Line ') + n).slice(0, 80),
          notes: String(p.notes || p.description || '').slice(0, 500),
          color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : (type === 'point' ? COLORS[0] : COLORS[5]),
          coords: type === 'point' ? [+coords[1], +coords[0]] : coords.map((c) => [+c[1], +c[0]])
        });
        added++;
      });
    });

    saveFeatures();
    features.forEach(renderFeature);
    renderList();
    if (added) map.fitBounds(featureGroup.getBounds(), { padding: [40, 40], maxZoom: 18 });
    toast('Imported ' + added + ' feature' + (added === 1 ? '' : 's') +
      (skipped ? ', skipped ' + skipped + ' (only points and lines are supported).' : '.'), 5000);
  }

  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file.text().then((text) => importGeoJSON(JSON.parse(text))).catch(() => toast('That file is not valid GeoJSON.'));
  };

  $('btnClear').onclick = () => {
    if (!features.length || !confirm('Delete all ' + features.length + ' features? This cannot be undone.')) return;
    deselect();
    featureGroup.clearLayers();
    layers.clear();
    features = [];
    saveFeatures();
    renderList();
  };

  // ---------------------------------------------------------------- sidebar
  $('search').oninput = renderList;
  $('chkLabels').checked = showLabels;
  $('chkLabels').onchange = (e) => {
    showLabels = e.target.checked;
    store(LABELS_KEY, showLabels);
    features.forEach(renderFeature);
  };
  $('btnSidebar').onclick = () => {
    $('sidebar').classList.toggle('collapsed');
    map.invalidateSize();
  };
  if (window.matchMedia('(max-width: 860px)').matches) $('sidebar').classList.add('collapsed');

  // ------------------------------------------------------------------- init
  features.forEach(renderFeature);
  renderList();
  map.invalidateSize();
  $('cursorPos').textContent = fmtCoord([map.getCenter().lat, map.getCenter().lng]);
})();
