// Carte : Google Maps si une clé est configurée, sinon OpenStreetMap (Leaflet).
// Les deux implémentations exposent la même interface à app.js :
//   addMarker({ lat, lng, html, title, zIndex, onClick }) -> { setHtml, show, hide }
//   flyTo(lat, lng, zoom), fitBounds([[lat, lng], ...]), getZoom(), onZoom(cb),
//   onMapClick(cb | null), geocode(adresse) -> { lat, lng, address } | null,
//   getBounds() -> { minLat, maxLat, minLng, maxLng } | null, onMove(cb) (après un déplacement ou un zoom),
//   setShapes([{ id, name, geometry (GeoJSON) }]) : remplace les contours dessinés (zonings),
//   setCircle({ lat, lng, radius (m) } | null) : cercle de recherche autour d'un point, cadré à l'écran,
//   onBackgroundClick(cb | null) : clic sur le fond de carte hors placement d'un point -> (lat, lng),
//   onPoiClick(cb | null) : clic sur un lieu de la carte Google (commerce, entreprise…) -> { lat, lng, placeId } ;
//                           sans effet sur OpenStreetMap, qui n'a pas de lieux cliquables

const BRUSSELS = { lat: 50.85, lng: 4.36 };

function markerElement(html) {
  const el = document.createElement('div');
  el.className = 'mk';
  el.innerHTML = html;
  return el;
}

// --- Google Maps ------------------------------------------------------------------

function loadGoogleScript(key) {
  return new Promise((resolve, reject) => {
    window.__cwGoogleReady = resolve;
    // Clé refusée par Google (mauvaise clé, domaine non autorisé…) : on repasse sur OpenStreetMap.
    // Google écrit la raison du refus dans la console (« ...MapError ») : on la garde pour l'afficher à l'équipe.
    const consoleError = console.error;
    console.error = (...a) => {
      const m = String(a[0] ?? '').match(/Google Maps JavaScript API error: (\w+)/);
      if (m) { try { sessionStorage.setItem('cw-map-reason', m[1]); } catch {} }
      consoleError.apply(console, a);
    };
    window.gm_authFailure = () => {
      try { sessionStorage.setItem('cw-map-fallback', String(Date.now())); } catch {}
      location.reload();
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + '&v=weekly&libraries=marker&loading=async&language=fr&region=BE&callback=__cwGoogleReady';
    s.async = true;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function createGoogleMap(el, { key, mapId }) {
  await loadGoogleScript(key);
  const { Map, MapTypeControlStyle } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  const { ControlPosition } = await google.maps.importLibrary('core');
  const map = new Map(el, {
    center: BRUSSELS, zoom: 12, mapId: mapId || 'DEMO_MAP_ID',
    // Bouton « Plan / Satellite » (satellite avec noms de rues : utile pour repérer les toitures).
    mapTypeControl: true,
    mapTypeControlOptions: {
      mapTypeIds: ['roadmap', 'hybrid'],
      style: MapTypeControlStyle.HORIZONTAL_BAR,
      position: ControlPosition.TOP_LEFT,
    },
    streetViewControl: false, fullscreenControl: false, clickableIcons: false,
  });
  let clickHandler = null, poiHandler = null, bgHandler = null;
  map.addListener('click', (e) => {
    // Clic sur un lieu Google : pas de bulle d'information standard, c'est la page qui décide quoi afficher.
    if (e.placeId && poiHandler && !clickHandler) { e.stop(); poiHandler({ lat: e.latLng.lat(), lng: e.latLng.lng(), placeId: e.placeId }); return; }
    if (clickHandler) clickHandler(e.latLng.lat(), e.latLng.lng());
    else if (bgHandler) bgHandler(e.latLng.lat(), e.latLng.lng());
  });

  return {
    kind: 'google',
    addMarker({ lat, lng, html, title, zIndex, onClick }) {
      // .mk fait 0×0 px et ses enfants sont centrés dessus en CSS : l'ancrage tombe pile sur le point.
      const content = markerElement(html);
      const m = new AdvancedMarkerElement({ position: { lat, lng }, content, title, zIndex, gmpClickable: !!onClick });
      if (onClick) m.addListener('click', onClick);
      return {
        setHtml(h) { content.innerHTML = h; },
        show() { if (!m.map) m.map = map; },
        hide() { m.map = null; },
      };
    },
    flyTo(lat, lng, zoom) { map.panTo({ lat, lng }); if (zoom) map.setZoom(Math.max(map.getZoom(), zoom)); },
    fitBounds(points) {
      const b = new google.maps.LatLngBounds();
      points.forEach(([lat, lng]) => b.extend({ lat, lng }));
      map.fitBounds(b, 40);
    },
    getZoom: () => map.getZoom(),
    onZoom(cb) { map.addListener('zoom_changed', cb); },
    getBounds() {
      const b = map.getBounds(); if (!b) return null;
      const sw = b.getSouthWest(), ne = b.getNorthEast();
      return { minLat: sw.lat(), maxLat: ne.lat(), minLng: sw.lng(), maxLng: ne.lng() };
    },
    onMove(cb) { map.addListener('idle', cb); },
    onPoiClick(cb) { poiHandler = cb; map.setOptions({ clickableIcons: !!cb }); },
    onBackgroundClick(cb) { bgHandler = cb; },
    async placeAddress(placeId) {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ placeId }).catch(() => ({ results: [] }));
      return results[0]?.formatted_address ?? null;
    },
    setCircle(c) {
      if (this._circle) { this._circle.setMap(null); this._circle = null; }
      if (!c) return;
      this._circle = new google.maps.Circle({ map, center: { lat: c.lat, lng: c.lng }, radius: c.radius, clickable: false,
        strokeColor: '#FF8001', strokeWeight: 2, fillColor: '#FF8001', fillOpacity: 0.08 });
      map.fitBounds(this._circle.getBounds(), 60);
    },
    setShapes(shapes) {
      map.data.forEach((f) => map.data.remove(f));
      map.data.setStyle({ fillColor: '#2E5E8C', fillOpacity: 0.1, strokeColor: '#2E5E8C', strokeWeight: 1.2, clickable: false });
      if (shapes.length) {
        map.data.addGeoJson({ type: 'FeatureCollection', features: shapes.map((s) => ({ type: 'Feature', id: s.id, properties: { name: s.name }, geometry: s.geometry })) });
      }
    },
    onMapClick(cb) { clickHandler = cb; map.setOptions({ draggableCursor: cb ? 'crosshair' : null }); },
    async geocode(address) {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ address, region: 'BE' }).catch(() => ({ results: [] }));
      if (!results.length) return null;
      const loc = results[0].geometry.location;
      return { lat: loc.lat(), lng: loc.lng(), address: results[0].formatted_address };
    },
  };
}

// --- OpenStreetMap (Leaflet) --------------------------------------------------------

function createLeafletMap(el) {
  const map = L.map(el, { zoomControl: true }).setView([BRUSSELS.lat, BRUSSELS.lng], 12);
  // Fond de carte OpenStreetMap : gratuit, sans clé (usage modéré, attribution obligatoire).
  const plan = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  // Vue satellite de secours (Esri World Imagery, gratuite, attribution obligatoire).
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagerie &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  });
  L.control.layers({ Plan: plan, Satellite: satellite }, null, { position: 'topleft', collapsed: false }).addTo(map);
  let clickHandler = null, bgHandler = null;
  map.on('click', (e) => { const h = clickHandler || bgHandler; if (h) h(e.latlng.lat, e.latlng.lng); });

  return {
    kind: 'osm',
    addMarker({ lat, lng, html, title, zIndex, onClick }) {
      const icon = (h) => L.divIcon({ className: '', html: `<div class="mk">${h}</div>`, iconSize: [0, 0] });
      const m = L.marker([lat, lng], { icon: icon(html), title, zIndexOffset: zIndex || 0, interactive: !!onClick });
      if (onClick) m.on('click', onClick);
      return {
        setHtml(h) { m.setIcon(icon(h)); },
        show() { if (!map.hasLayer(m)) m.addTo(map); },
        hide() { m.remove(); },
      };
    },
    flyTo(lat, lng, zoom) { map.flyTo([lat, lng], Math.max(map.getZoom(), zoom || 0), { duration: 0.5 }); },
    fitBounds(points) { map.fitBounds(points, { padding: [40, 40] }); },
    getZoom: () => map.getZoom(),
    onZoom(cb) { map.on('zoomend', cb); },
    getBounds() {
      const b = map.getBounds();
      return { minLat: b.getSouth(), maxLat: b.getNorth(), minLng: b.getWest(), maxLng: b.getEast() };
    },
    onMove(cb) { map.on('moveend', cb); },
    onPoiClick() {},
    onBackgroundClick(cb) { bgHandler = cb; },
    async placeAddress() { return null; },
    setCircle(c) {
      if (this._circle) { this._circle.remove(); this._circle = null; }
      if (!c) return;
      this._circle = L.circle([c.lat, c.lng], { radius: c.radius, color: '#FF8001', weight: 2, fillColor: '#FF8001', fillOpacity: 0.08, interactive: false }).addTo(map);
      map.fitBounds(this._circle.getBounds(), { padding: [60, 60] });
    },
    setShapes(shapes) {
      if (this._shapes) this._shapes.remove();
      this._shapes = shapes.length ? L.geoJSON({ type: 'FeatureCollection', features: shapes.map((s) => ({ type: 'Feature', properties: { name: s.name }, geometry: s.geometry })) },
        { style: { color: '#2E5E8C', weight: 1.2, fillColor: '#2E5E8C', fillOpacity: 0.1 }, interactive: false }).addTo(map) : null;
    },
    onMapClick(cb) { clickHandler = cb; el.style.cursor = cb ? 'crosshair' : ''; },
    async geocode(address) {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=be&q='
        + encodeURIComponent(address);
      const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } }).catch(() => null);
      const [hit] = res && res.ok ? await res.json() : [];
      return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), address: hit.display_name } : null;
    },
  };
}

async function createMap(el) {
  const cfg = window.CITYWATT_CONFIG || {};
  let fallback = false;
  // Le repli sur OpenStreetMap ne dure que dix minutes : Google est réessayé ensuite (clé corrigée entre-temps, par exemple).
  try { fallback = Date.now() - Number(sessionStorage.getItem('cw-map-fallback') || 0) < 600000; } catch {}
  if (cfg.googleMapsApiKey && !fallback) {
    try {
      return await createGoogleMap(el, { key: cfg.googleMapsApiKey, mapId: cfg.googleMapId });
    } catch (e) {
      console.error('Google Maps indisponible, passage sur OpenStreetMap', e);
      el.innerHTML = '';
    }
  }
  return createLeafletMap(el);
}
