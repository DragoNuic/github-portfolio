/* ============================================================
   Vienna — Social Housing Atlas interactive map
   D3-rendered SVG map: base map + social housing layer,
   decade scrubber (cumulative growth), colour-mode toggle,
   zoom/pan, and hover/click markers for notable buildings.
   ============================================================ */

const DECADE_BUCKETS = [
  'Pre-1900','1900–1910','1910–1920','1920–1930','1930–1940','1940–1950',
  '1950–1960','1960–1970','1970–1980','1980–1990','1990–2000','2000–2010'
];

const MARKERS = [
  { name: 'Metzleinstalerhof', lat: 48.181473, lng: 16.349166, url: 'https://www.geschichtewiki.wien.gv.at/Metzleinstaler_Hof' },
  { name: 'Reumannhof',        lat: 48.182703, lng: 16.348004, url: 'https://www.geschichtewiki.wien.gv.at/Reumannhof' },
  { name: 'Karl-Marx-Hof',     lat: 48.250184, lng: 16.364238, url: 'https://www.geschichtewiki.wien.gv.at/Karl-Marx-Hof' },
  { name: 'Wohnhausanlage Sandleiten', lat: 48.222511, lng: 16.305184, url: 'https://www.geschichtewiki.wien.gv.at/Wohnhausanlage_Sandleiten' }
];

const YELLOW = '#F2B705';
const TIMELINE_STOPS = ['#33517A', '#3E7C87', '#5C9E6F', '#A3AE4E', '#F2B705'];

function lerpColor(stops, t){
  t = Math.max(0, Math.min(1, t));
  const n = stops.length - 1;
  const seg = Math.min(n - 1, Math.floor(t * n));
  const localT = (t * n) - seg;
  const c1 = hexToRgb(stops[seg]), c2 = hexToRgb(stops[seg + 1]);
  const r = Math.round(c1.r + (c2.r - c1.r) * localT);
  const g = Math.round(c1.g + (c2.g - c1.g) * localT);
  const b = Math.round(c1.b + (c2.b - c1.b) * localT);
  return `rgb(${r},${g},${b})`;
}
function hexToRgb(hex){
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function timelineColor(bucketIdx){
  return lerpColor(TIMELINE_STOPS, bucketIdx / (DECADE_BUCKETS.length - 1));
}
function bucketIndex(decade){
  if (decade == null || decade < 1900) return 0;
  return Math.min(11, Math.floor((decade - 1900) / 10) + 1);
}

// CSV columns: decade,buildings,units — one row per decade bucket start year.
function parseUnitStatsCsv(text){
  const stats = DECADE_BUCKETS.map(() => ({ buildings: 0, units: 0 }));
  text.trim().split('\n').slice(1).forEach(line => {
    const [decade, buildings, units] = line.split(',').map(Number);
    stats[bucketIndex(decade)] = { buildings, units };
  });
  return stats;
}

(async function initViennaMap(){
  const stage = document.getElementById('vmap-stage');
  const svg = d3.select('#vmap-svg');
  const g = svg.append('g').attr('id', 'vmap-zoom-layer');
  const baseLayer = g.append('g').attr('id', 'vmap-base');
  const housingLayer = g.append('g').attr('id', 'vmap-housing');
  const markerLayer = document.getElementById('vmap-markers');
  const loadingEl = document.getElementById('vmap-loading');
  const countEl = document.getElementById('vmap-count');
  const decadeReadout = document.getElementById('vmap-decade-readout');
  const slider = document.getElementById('vmap-slider');
  const legendEl = document.getElementById('vmap-legend');
  const modeButtons = document.querySelectorAll('.vmap-mode-btn');
  const ticksEl = document.getElementById('vmap-ticks');
  const unitsEl = document.getElementById('vmap-units');
  const unitBarsEl = document.getElementById('vmap-unit-bars');

  ticksEl.innerHTML = DECADE_BUCKETS.map(l => `<span>${l.replace('–2010','s').replace(/^(\d{4})–\d{4}$/,'$1s')}</span>`).join('');

  const W = 1000, H = 720;
  svg.attr('viewBox', `0 0 ${W} ${H}`);

  let colorMode = 'single'; // 'single' | 'timeline'
  let projection, path;

  try {
    const [basemap, housing, unitStatsCsv] = await Promise.all([
      fetch('data/base-map-vienna.geojson').then(r => { if(!r.ok) throw new Error('base map fetch failed'); return r.json(); }),
      fetch('data/social-housing-vienna.geojson').then(r => { if(!r.ok) throw new Error('housing fetch failed'); return r.json(); }),
      fetch('data/vienna-housing-units.csv').then(r => { if(!r.ok) throw new Error('unit stats fetch failed'); return r.text(); })
    ]);

    const unitStats = parseUnitStatsCsv(unitStatsCsv);
    const maxUnits = Math.max(...unitStats.map(s => s.units));
    unitBarsEl.innerHTML = DECADE_BUCKETS.map(() => '<span class="vmap-unit-bar"></span>').join('');
    const unitBars = unitBarsEl.querySelectorAll('.vmap-unit-bar');

    projection = d3.geoMercator().fitSize([W, H], basemap);
    path = d3.geoPath(projection);

    // --- base map: thin context lines, near-invisible fill ---
    baseLayer.selectAll('path')
      .data(basemap.features)
      .join('path')
      .attr('d', path)
      .attr('class', 'vmap-base-path');

    // --- social housing: the hero layer ---
    housing.features.forEach(f => { f._bucket = bucketIndex(f.properties.decade); });

    const housingPaths = housingLayer.selectAll('path')
      .data(housing.features)
      .join('path')
      .attr('d', path)
      .attr('class', 'vmap-house-path');

    function render(){
      const cutoff = +slider.value;
      let visible = 0;
      housingPaths.each(function(d){
        const show = d._bucket <= cutoff;
        if (show) visible++;
        d3.select(this)
          .style('display', show ? null : 'none')
          .attr('fill', colorMode === 'timeline' ? timelineColor(d._bucket) : YELLOW);
      });
      countEl.textContent = visible.toLocaleString('en-GB');
      decadeReadout.textContent = DECADE_BUCKETS[cutoff];
      renderLegend();
      renderUnitChart(cutoff);
    }

    function renderUnitChart(cutoff){
      let cumulativeUnits = 0;
      unitBars.forEach((bar, idx) => {
        const isBuilt = idx <= cutoff;
        if (isBuilt) cumulativeUnits += unitStats[idx].units;
        const h = maxUnits ? Math.max(3, Math.round((unitStats[idx].units / maxUnits) * 100)) : 3;
        bar.style.height = h + '%';
        bar.classList.toggle('is-active', isBuilt);
      });
      unitsEl.textContent = cumulativeUnits.toLocaleString('en-GB');
    }

    function renderLegend(){
      if (colorMode === 'single'){
        legendEl.innerHTML = `
          <div class="vmap-legend-row"><span class="vmap-swatch" style="background:${YELLOW}"></span> City of Vienna Gemeindebau</div>`;
      } else {
        legendEl.innerHTML = `
          <div class="vmap-gradient" style="background:linear-gradient(90deg, ${TIMELINE_STOPS.join(',')})"></div>
          <div class="vmap-gradient-labels"><span>Pre-1900</span><span>2000s</span></div>`;
      }
    }

    slider.addEventListener('input', render);
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        colorMode = btn.dataset.mode;
        render();
      });
    });

    render();

    // --- markers: notable buildings with hover tooltip + click-through link ---
    MARKERS.forEach(m => {
      const [x, y] = projection([m.lng, m.lat]);
      const el = document.createElement('a');
      el.className = 'vmarker';
      el.href = m.url;
      el.target = '_blank';
      el.rel = 'noopener';
      el.dataset.x = x;
      el.dataset.y = y;
      el.innerHTML = `<span class="vmarker-dot"></span><span class="vmarker-label">${m.name}</span>`;
      markerLayer.appendChild(el);
    });

    // The SVG has a fixed viewBox but scales to fill its container with
    // preserveAspectRatio "meet", which letterboxes it (scales + centers)
    // whenever the container's aspect ratio doesn't match the viewBox's.
    // Markers live in a plain HTML layer on top of the SVG, so their pixel
    // position has to account for that same scale/offset, not just the
    // raw viewBox coordinates.
    function svgToPixelBase(){
      const rect = svg.node().getBoundingClientRect();
      const scale = Math.min(rect.width / W, rect.height / H);
      return {
        scale,
        offsetX: (rect.width - W * scale) / 2,
        offsetY: (rect.height - H * scale) / 2
      };
    }

    let lastTransform = d3.zoomIdentity;
    function positionMarkers(transform){
      lastTransform = transform;
      const { scale, offsetX, offsetY } = svgToPixelBase();
      markerLayer.querySelectorAll('.vmarker').forEach(el => {
        const x = +el.dataset.x, y = +el.dataset.y;
        const tx = offsetX + transform.applyX(x) * scale;
        const ty = offsetY + transform.applyY(y) * scale;
        el.style.transform = `translate(${tx}px, ${ty}px) scale(${1 / transform.k})`;
      });
    }

    // --- zoom / pan ---
    const zoom = d3.zoom()
      .scaleExtent([1, 16])
      .translateExtent([[0, 0], [W, H]])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
        positionMarkers(event.transform);
      });
    svg.call(zoom);
    positionMarkers(d3.zoomIdentity);

    window.addEventListener('resize', () => positionMarkers(lastTransform));
    if (window.ResizeObserver){
      new ResizeObserver(() => positionMarkers(lastTransform)).observe(stage);
    }

    loadingEl.style.display = 'none';
    stage.classList.add('is-ready');

  } catch (err){
    console.error(err);
    loadingEl.innerHTML = 'Map data could not be loaded. If you\'re viewing this file directly from disk, serve it over local http(s) — browsers block GeoJSON fetches from file:// URLs.';
  }
})();
