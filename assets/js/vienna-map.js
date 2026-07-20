/* ============================================================
   Vienna — Social Housing Atlas interactive map
   D3-rendered SVG map: base map + social housing layer,
   decade scrubber (cumulative growth), colour-mode toggle,
   zoom/pan.
   ============================================================ */

const DECADE_BUCKETS = [
  'Pre-1900','1900–1910','1910–1920','1920–1930','1930–1940','1940–1950',
  '1950–1960','1960–1970','1970–1980','1980–1990','1990–2000','2000–2010'
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

// CSV columns: year,population — irregular census years, linearly
// interpolated to line up with the decade buckets used everywhere else.
function parsePopulationCsv(text){
  return text.trim().split('\n').slice(1)
    .map(line => { const [year, population] = line.split(',').map(Number); return { year, population }; })
    .sort((a, b) => a.year - b.year);
}
function interpolatePopulation(year, points){
  if (year <= points[0].year) return points[0].population;
  const last = points[points.length - 1];
  if (year >= last.year) return last.population;
  for (let i = 0; i < points.length - 1; i++){
    const a = points[i], b = points[i + 1];
    if (year >= a.year && year <= b.year){
      const t = (year - a.year) / (b.year - a.year);
      return a.population + (b.population - a.population) * t;
    }
  }
  return last.population;
}
function bucketEndYear(bucketIdx){
  return bucketIdx === 0 ? 1900 : 1900 + bucketIdx * 10;
}
function shortDecadeLabel(l){
  return l.replace('–2010', 's').replace(/^(\d{4})–\d{4}$/, '$1s');
}

(async function initViennaMap(){
  const stage = document.getElementById('vmap-stage');
  const svg = d3.select('#vmap-svg');
  const g = svg.append('g').attr('id', 'vmap-zoom-layer');
  const baseLayer = g.append('g').attr('id', 'vmap-base');
  const housingLayer = g.append('g').attr('id', 'vmap-housing');
  const loadingEl = document.getElementById('vmap-loading');
  const countEl = document.getElementById('vmap-count');
  const decadeReadout = document.getElementById('vmap-decade-readout');
  const slider = document.getElementById('vmap-slider');
  const legendEl = document.getElementById('vmap-legend');
  const modeButtons = document.querySelectorAll('.vmap-mode-btn');
  const ticksEl = document.getElementById('vmap-ticks');
  const unitsEl = document.getElementById('vmap-units');
  const unitBarsEl = document.getElementById('vmap-unit-bars');
  const populationEl = document.getElementById('vmap-population');
  const popPolylineEl = document.getElementById('vmap-pop-polyline');
  const popDotEl = document.getElementById('vmap-pop-dot');
  const decadeListEl = document.getElementById('vmap-decade-list');
  const decadeClearBtn = document.getElementById('vmap-decade-clear');

  ticksEl.innerHTML = DECADE_BUCKETS.map(l => `<span>${shortDecadeLabel(l)}</span>`).join('');

  decadeListEl.innerHTML = DECADE_BUCKETS.map((l, i) => `
    <li><button type="button" class="vmap-decade-chip" data-bucket="${i}">
      <span class="vmap-decade-swatch"></span><span>${shortDecadeLabel(l)}</span>
    </button></li>`).join('');
  const decadeChips = decadeListEl.querySelectorAll('.vmap-decade-chip');

  const W = 1000, H = 720;
  svg.attr('viewBox', `0 0 ${W} ${H}`);

  let colorMode = 'single'; // 'single' | 'timeline'
  let isolatedBuckets = new Set(); // when non-empty, only these buckets show, overriding the slider

  try {
    const [basemap, housing, unitStatsCsv, populationCsv] = await Promise.all([
      fetch('data/base-map-vienna.geojson').then(r => { if(!r.ok) throw new Error('base map fetch failed'); return r.json(); }),
      fetch('data/social-housing-vienna.geojson').then(r => { if(!r.ok) throw new Error('housing fetch failed'); return r.json(); }),
      fetch('data/vienna-housing-units.csv').then(r => { if(!r.ok) throw new Error('unit stats fetch failed'); return r.text(); }),
      fetch('data/vienna-population.csv').then(r => { if(!r.ok) throw new Error('population fetch failed'); return r.text(); })
    ]);

    const unitStats = parseUnitStatsCsv(unitStatsCsv);
    const maxUnits = Math.max(...unitStats.map(s => s.units));
    unitBarsEl.innerHTML = DECADE_BUCKETS.map(() => '<span class="vmap-unit-bar"></span>').join('');
    const unitBars = unitBarsEl.querySelectorAll('.vmap-unit-bar');

    // Population line: interpolated onto each bucket's end year, then
    // plotted in a 0–100 normalised space (x = bucket slot, y = value)
    // so it overlays the bars regardless of the chart's rendered size.
    const populationPoints = parsePopulationCsv(populationCsv);
    const popByBucket = DECADE_BUCKETS.map((_, i) => interpolatePopulation(bucketEndYear(i), populationPoints));
    const popMin = Math.min(...popByBucket), popMax = Math.max(...popByBucket);
    const popPadding = 12;
    function popY(pop){
      const t = (pop - popMin) / ((popMax - popMin) || 1);
      return 100 - popPadding - t * (100 - popPadding * 2);
    }
    function popX(bucketIdx){
      return (bucketIdx + 0.5) / DECADE_BUCKETS.length * 100;
    }
    popPolylineEl.setAttribute('points', popByBucket.map((p, i) => `${popX(i)},${popY(p)}`).join(' '));

    const projection = d3.geoMercator().fitSize([W, H], basemap);
    const path = d3.geoPath(projection);

    // --- base map: thin context lines, near-invisible fill ---
    // 11k+ features is far too many individual DOM nodes to pan/zoom
    // smoothly — it's static context with no per-feature styling, so it's
    // merged into a single <path> (one "d" string with many subpaths).
    baseLayer.append('path')
      .attr('class', 'vmap-base-path')
      .attr('d', basemap.features.map(f => path(f)).filter(Boolean).join(' '));

    // --- social housing: the hero layer ---
    // Buildings are only ever shown/hidden a whole decade-bucket at a time
    // (the timeline slider), so there's no need for one DOM element per
    // building — group by bucket and merge each group into one path.
    housing.features.forEach(f => { f._bucket = bucketIndex(f.properties.decade); });
    const bucketGroups = d3.groups(housing.features, f => f._bucket).sort((a, b) => a[0] - b[0]);

    const housingPaths = housingLayer.selectAll('path')
      .data(bucketGroups)
      .join('path')
      .attr('class', 'vmap-house-path')
      .attr('d', ([, feats]) => feats.map(f => path(f)).filter(Boolean).join(' '));

    function render(){
      const cutoff = +slider.value;
      const isolating = isolatedBuckets.size > 0;
      let visible = 0;
      housingPaths.each(function([bucket, feats]){
        const show = isolating ? isolatedBuckets.has(bucket) : bucket <= cutoff;
        if (show) visible += feats.length;
        d3.select(this)
          .style('display', show ? null : 'none')
          .attr('fill', colorMode === 'timeline' ? timelineColor(bucket) : YELLOW);
      });
      housingLayer.classed('is-timeline', colorMode === 'timeline');
      countEl.textContent = visible.toLocaleString('en-GB');
      decadeReadout.textContent = isolating
        ? `${isolatedBuckets.size} decade${isolatedBuckets.size > 1 ? 's' : ''} isolated`
        : DECADE_BUCKETS[cutoff];
      renderLegend();
      renderUnitChart(cutoff);
      renderPopulation(cutoff);
      renderDecadeChips();
    }

    function renderDecadeChips(){
      decadeChips.forEach(chip => {
        const bucket = +chip.dataset.bucket;
        chip.querySelector('.vmap-decade-swatch').style.background =
          colorMode === 'timeline' ? timelineColor(bucket) : YELLOW;
        chip.classList.toggle('is-isolated', isolatedBuckets.has(bucket));
      });
      decadeListEl.classList.toggle('has-isolation', isolatedBuckets.size > 0);
      decadeClearBtn.classList.toggle('is-visible', isolatedBuckets.size > 0);
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

    function renderPopulation(cutoff){
      popDotEl.style.left = popX(cutoff) + '%';
      popDotEl.style.top = popY(popByBucket[cutoff]) + '%';
      populationEl.textContent = Math.round(popByBucket[cutoff]).toLocaleString('en-GB');
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

    slider.addEventListener('input', () => {
      isolatedBuckets.clear(); // dragging the timeline always returns to cumulative mode
      render();
    });
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        colorMode = btn.dataset.mode;
        render();
      });
    });
    decadeChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const bucket = +chip.dataset.bucket;
        if (isolatedBuckets.has(bucket)) isolatedBuckets.delete(bucket);
        else isolatedBuckets.add(bucket);
        render();
      });
    });
    decadeClearBtn.addEventListener('click', () => {
      isolatedBuckets.clear();
      render();
    });

    render();

    // --- zoom / pan ---
    const zoom = d3.zoom()
      .scaleExtent([1, 16])
      .translateExtent([[0, 0], [W, H]])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    loadingEl.style.display = 'none';
    stage.classList.add('is-ready');

  } catch (err){
    console.error(err);
    loadingEl.innerHTML = 'Map data could not be loaded. If you\'re viewing this file directly from disk, serve it over local http(s) — browsers block GeoJSON fetches from file:// URLs.';
  }
})();
