<script lang="ts">
	// @ts-ignore — UMD module loaded via namespace import for Rollup compatibility
	import * as maplibreglModule from 'maplibre-gl';
	const maplibregl = (maplibreglModule as any).default ?? maplibreglModule;
	import 'maplibre-gl/dist/maplibre-gl.css';
	import * as topojson from 'topojson-client';
	import { cellToBoundary, latLngToCell } from 'h3-js';
	import { onMount } from 'svelte';

	// ── Types ───────────────────────────────────────────────────
	interface LandHex { h3: string; lat: number; lon: number; clip?: number[][]; multiClip?: number[][][]; }
	interface Country { name: string; fill: string; border: string; }
	interface Province { name: string; color: string; }

	// ── Default countries from game nations ─────────────────────
	const DEFAULT_COUNTRIES: Record<string, Country> = {
		british: { name: 'British Empire', fill: '#C45B5B', border: '#8B3030' },
		french: { name: 'French Empire', fill: '#5B7BC4', border: '#3050A0' },
		german: { name: 'German Empire', fill: '#8B8B8B', border: '#5B5B5B' },
		american: { name: 'United States', fill: '#6B9B5B', border: '#3B6B2B' },
		dutch: { name: 'Netherlands', fill: '#D4944A', border: '#A06820' },
		italian: { name: 'Italian States', fill: '#7BAA6B', border: '#4B7A3B' },
		spanish: { name: 'Spanish Empire', fill: '#D4B44A', border: '#A08420' },
		ottoman: { name: 'Ottoman Empire', fill: '#9B4A4A', border: '#6B2020' },
		scandinavian: { name: 'Scandinavian', fill: '#7BAAC4', border: '#4B7A94' },
		portuguese: { name: 'Portuguese Empire', fill: '#4A9B8B', border: '#206B5B' },
		japanese: { name: 'Japan (Meiji)', fill: '#D47B7B', border: '#A04B4B' },
		chinese: { name: 'Qing China', fill: '#C4A44A', border: '#947420' }
	};

	// Distinct province colors (auto-assigned on creation)
	const PROVINCE_PALETTE = [
		'#E6B8AF','#F4CCCC','#FCE5CD','#FFF2CC','#D9EAD3','#D0E0E3','#C9DAF8','#D9D2E9',
		'#EAD1DC','#DD7E6B','#EA9999','#F9CB9C','#FFE599','#B6D7A8','#A2C4C9','#A4C2F4',
		'#B4A7D6','#D5A6BD','#CC4125','#E06666','#F6B26B','#FFD966','#93C47D','#76A5AF',
		'#6D9EEB','#8E7CC3','#C27BA0','#A61C00','#CC0000','#E69138','#F1C232','#6AA84F',
		'#45818E','#3C78D8','#674EA7','#A64D79'
	];

	// ── State ───────────────────────────────────────────────────
	let mapContainer: HTMLDivElement;
	let map: any = null;
	let importInput: HTMLInputElement;

	// Data — NOT reactive
	let landHexes: LandHex[] = [];
	let landHexSet: Set<string> = new Set();
	let hexGeoJSON: GeoJSON.FeatureCollection | null = null;

	// Province data — reactive since the sidebar lists iterate these
	let provinces = $state<Record<string, Province>>({});
	let hexToProvince: Record<string, string> = {};   // h3 -> provinceId (not reactive — use dataVersion)
	let provinceToCountry = $state<Record<string, string>>({}); // provinceId -> countryCode

	// UI state — reactive
	let countries = $state<Record<string, Country>>({ ...DEFAULT_COUNTRIES });
	let hexCount = $state(0);
	let dataVersion = $state(0); // bump to trigger derived recalcs
	let editorMode = $state<'province' | 'country'>('province');
	let selectedProvince = $state<string | null>(null);
	let selectedCountry = $state<string | null>(null);
	let tool = $state<'paint' | 'erase' | 'pick'>('paint');
	let loading = $state(true);
	let loadingMessage = $state('Initializing...');
	let hoveredHexId = $state<string | null>(null);
	let showBorders = $state(false);
	let showStates = $state(false);
	let showHexBorders = $state(true);
	let isPainting = false;
	let showAddForm = $state(false);
	let newItemName = $state('');
	let newItemCode = $state('');
	let showGrid = $state(true);
	let mapReady = false;
	let nextProvinceId = 1;

	// Derived stats
	let provinceCount = $derived(dataVersion >= 0 ? Object.keys(provinces).length : 0);
	let hexesByProvince = $derived.by(() => {
		void dataVersion;
		const counts: Record<string, number> = {};
		for (const pid of Object.values(hexToProvince)) {
			counts[pid] = (counts[pid] || 0) + 1;
		}
		return counts;
	});
	let provincesByCountry = $derived.by(() => {
		void dataVersion;
		const counts: Record<string, number> = {};
		for (const code of Object.values(provinceToCountry)) {
			counts[code] = (counts[code] || 0) + 1;
		}
		return counts;
	});

	// ── Lifecycle ───────────────────────────────────────────────
	onMount(async () => {
		loadingMessage = 'Loading land hexes (first time may take ~30s)...';
		try {
			const res = await fetch('/api/land-hexes');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			landHexes = await res.json();
			landHexSet = new Set(landHexes.map((h) => h.h3));
			hexCount = landHexes.length;
			loadingMessage = `Loaded ${hexCount.toLocaleString()} land hexes. Building map...`;
		} catch (e) {
			loadingMessage = `Failed to load land hexes: ${e}`;
			return;
		}
		initMap();
	});

	// ── Export / Import ─────────────────────────────────────────
	let saveFileHandle: FileSystemFileHandle | null = null;

	async function exportData() {
		const data = { version: 2, hexResolution: 4, countries, provinces, hexToProvince, provinceToCountry };
		const json = JSON.stringify(data, null, 2);

		// Use File System Access API — lets user pick location, overwrites same file on subsequent saves
		if ('showSaveFilePicker' in window) {
			try {
				if (!saveFileHandle) {
					saveFileHandle = await (window as any).showSaveFilePicker({
						suggestedName: 'country-painting.json',
						types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
					});
				}
				const writable = await saveFileHandle!.createWritable();
				await writable.write(json);
				await writable.close();
				return;
			} catch (e: any) {
				if (e.name === 'AbortError') return; // user cancelled
				// Fall through to download
			}
		}

		// Fallback for browsers without File System Access API
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'country-painting.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	function importData(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const data = JSON.parse(reader.result as string);
				if (data.countries) countries = data.countries;
				if (data.provinces) provinces = data.provinces;
				if (data.hexToProvince) hexToProvince = data.hexToProvince;
				if (data.provinceToCountry) provinceToCountry = data.provinceToCountry;
				// Restore nextProvinceId
				for (const id of Object.keys(provinces)) {
					const num = parseInt(id.replace('prov_', ''));
					if (!isNaN(num) && num >= nextProvinceId) nextProvinceId = num + 1;
				}
				// Add any coastal hexes from saved data that aren't in the land hex set
				addMissingHexesToSource();
				dataVersion++;
				refreshMapColors();
			} catch (err) {
				alert('Failed to import: ' + err);
			}
		};
		reader.readAsText(file);
		(e.target as HTMLInputElement).value = '';
	}

	// ── Map Initialization ──────────────────────────────────────
	function initMap() {
		if (mapReady) return;
		mapReady = true;
		map = new maplibregl.Map({
			container: mapContainer,
			style: {
				version: 8 as const,
				name: 'Country Painter',
				sources: {},
				layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#8A9BAE' } }],
				glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
			},
			center: [-20, 35],
			zoom: 2,
			maxPitch: 85,
			attributionControl: false
		});
		map.on('load', async () => {
			map!.setProjection({ type: 'globe' } as any);
			await addLayers();
			refreshMapColors();
			setupInteractions();
			loading = false;
		});
	}

	// ── Map Layers ──────────────────────────────────────────────
	async function addLayers() {
		if (!map) return;
		loadingMessage = 'Loading map data...';
		const [countryRes, waterRes, statesRes] = await Promise.all([
			fetch('/data/countries-10m.json'),
			fetch('/data/waterways-10m.json'),
			fetch('/data/states-10m.json')
		]);
		const countryTopo = await countryRes.json();
		const waterTopo = await waterRes.json();
		const statesTopo = await statesRes.json();
		const countriesGeo = fixAntiMeridian(
			topojson.feature(countryTopo, countryTopo.objects.countries) as unknown as GeoJSON.FeatureCollection
		);
		const riversGeo = topojson.feature(waterTopo, waterTopo.objects.rivers) as unknown as GeoJSON.FeatureCollection;
		const lakesGeo = topojson.feature(waterTopo, waterTopo.objects.lakes) as unknown as GeoJSON.FeatureCollection;

		// 1. Land fill
		map.addSource('land', { type: 'geojson', data: countriesGeo });
		map.addLayer({ id: 'land-fill', type: 'fill', source: 'land', paint: { 'fill-color': '#D4C9B8', 'fill-opacity': 0.999 } });
		const landFillLayer = map.style._layers['land-fill'];
		if (landFillLayer) landFillLayer.isClipMaskSource = true;

		// 2. Hex fill
		loadingMessage = `Building ${hexCount.toLocaleString()} hex polygons...`;
		await new Promise((r) => setTimeout(r, 50));
		hexGeoJSON = buildHexGeoJSON();
		map.addSource('country-hexes', { type: 'geojson', data: hexGeoJSON, promoteId: 'h3' });
		map.addLayer({
			id: 'country-hex-fill', type: 'fill', source: 'country-hexes',
			paint: {
				'fill-color': ['coalesce', ['feature-state', 'fill'], 'transparent'],
				'fill-opacity': ['case', ['to-boolean', ['feature-state', 'painted']], 0.85, 0]
			}
		});
		const hexFillLayer = map.style._layers['country-hex-fill'];
		if (hexFillLayer) hexFillLayer.clipToSource = 'land';

		// 3. Hex borders
		map.addLayer({
			id: 'country-hex-border', type: 'line', source: 'country-hexes',
			paint: {
				'line-color': ['case', ['to-boolean', ['feature-state', 'painted']],
					['coalesce', ['feature-state', 'borderColor'], 'rgba(100,90,80,0.3)'], 'rgba(100,90,80,0.15)'],
				'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.2, 5, 0.8],
				'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0, 3, 0.3, 5, 0.6]
			},
			layout: { visibility: showGrid ? 'visible' : 'none' }
		});

		// 4. Rivers & Lakes
		map.addSource('rivers', { type: 'geojson', data: riversGeo });
		map.addLayer({ id: 'rivers-fill', type: 'fill', source: 'rivers', paint: { 'fill-color': '#8A9BAE', 'fill-opacity': 0.7 } });
		map.addSource('lakes', { type: 'geojson', data: lakesGeo });
		map.addLayer({ id: 'lakes-fill', type: 'fill', source: 'lakes', paint: { 'fill-color': '#8A9BAE', 'fill-opacity': 0.7 } });

		// 5. Modern country borders (reference overlay, off by default)
		map.addLayer({
			id: 'country-borders', type: 'line', source: 'land',
			paint: { 'line-color': '#FFD700', 'line-width': 1, 'line-opacity': 0.6 },
			layout: { visibility: 'none' }
		});

		// 6. States/provinces borders (reference overlay, off by default)
		const statesGeo = topojson.feature(statesTopo, statesTopo.objects.ne_10m_admin_1_states_provinces) as unknown as GeoJSON.FeatureCollection;
		map.addSource('states', { type: 'geojson', data: statesGeo });
		map.addLayer({
			id: 'state-borders', type: 'line', source: 'states',
			paint: { 'line-color': '#FF8C00', 'line-width': 0.6, 'line-opacity': 0.5 },
			layout: { visibility: 'none' }
		});
	}

	// ── Hex GeoJSON Builder ─────────────────────────────────────
	function buildHexGeoJSON(): GeoJSON.FeatureCollection {
		const features: GeoJSON.Feature[] = [];
		for (const hex of landHexes) {
			let coords: [number, number][];
			if (hex.clip) {
				coords = hex.clip as [number, number][];
			} else {
				const boundary = cellToBoundary(hex.h3);
				coords = boundary.map(([lat, lon]) => [lon, lat] as [number, number]);
				const lons = coords.map((c) => c[0]);
				if (Math.max(...lons) - Math.min(...lons) > 170) continue;
				coords.push(coords[0]);
			}
			if (hex.multiClip) {
				features.push({ type: 'Feature', properties: { h3: hex.h3 },
					geometry: { type: 'MultiPolygon', coordinates: hex.multiClip.map(ring => [ring as [number, number][]]) } });
			} else {
				features.push({ type: 'Feature', properties: { h3: hex.h3 },
					geometry: { type: 'Polygon', coordinates: [coords] } });
			}
		}
		return { type: 'FeatureCollection', features };
	}

	// ── Add missing coastal hexes to GeoJSON source ────────────
	function addMissingHexesToSource() {
		if (!hexGeoJSON || !map) return;
		let added = 0;
		for (const h3 of Object.keys(hexToProvince)) {
			if (landHexSet.has(h3)) continue;
			landHexSet.add(h3);
			const boundary = cellToBoundary(h3);
			const coords: [number, number][] = boundary.map(([lat, lon]) => [lon, lat] as [number, number]);
			if (Math.max(...coords.map(c => c[0])) - Math.min(...coords.map(c => c[0])) > 170) continue;
			coords.push(coords[0]);
			hexGeoJSON.features.push({ type: 'Feature', properties: { h3 }, geometry: { type: 'Polygon', coordinates: [coords] } });
			added++;
		}
		if (added > 0) {
			const source = map.getSource('country-hexes') as any;
			if (source) source.setData(hexGeoJSON);
			console.log(`[Country Painter] Added ${added} coastal hexes from saved data`);
		}
	}

	// ── Map Color Management ────────────────────────────────────
	function refreshMapColors() {
		if (!map) return;
		map.removeFeatureState({ source: 'country-hexes' });

		if (editorMode === 'province') {
			// Show province colors
			for (const [h3, provId] of Object.entries(hexToProvince)) {
				const prov = provinces[provId];
				if (prov) {
					map.setFeatureState({ source: 'country-hexes', id: h3 },
						{ painted: true, fill: prov.color, borderColor: darkenColor(prov.color) });
				}
			}
		} else {
			// Show country colors
			for (const [h3, provId] of Object.entries(hexToProvince)) {
				const countryCode = provinceToCountry[provId];
				const country = countryCode ? countries[countryCode] : null;
				if (country) {
					map.setFeatureState({ source: 'country-hexes', id: h3 },
						{ painted: true, fill: country.fill, borderColor: country.border });
				} else {
					// Province exists but no country assigned — show faint
					const prov = provinces[provId];
					if (prov) {
						map.setFeatureState({ source: 'country-hexes', id: h3 },
							{ painted: true, fill: prov.color, borderColor: darkenColor(prov.color) });
					}
				}
			}
		}
	}

	// ── Interactions ─────────────────────────────────────────────
	const H3_RES = 4;

	function getHexAtPoint(point: any, lngLat: { lng: number; lat: number }): string | null {
		const landFeatures = map!.queryRenderedFeatures(point, { layers: ['land-fill'] });
		if (landFeatures.length === 0) return null;
		const h3 = latLngToCell(lngLat.lat, lngLat.lng, H3_RES);
		if (landHexSet.has(h3)) return h3;
		// Coastal hex
		if (!hexGeoJSON) return null;
		landHexSet.add(h3);
		const boundary = cellToBoundary(h3);
		const coords: [number, number][] = boundary.map(([lat, lon]) => [lon, lat] as [number, number]);
		if (Math.max(...coords.map(c => c[0])) - Math.min(...coords.map(c => c[0])) > 170) return null;
		coords.push(coords[0]);
		hexGeoJSON.features.push({ type: 'Feature', properties: { h3 }, geometry: { type: 'Polygon', coordinates: [coords] } });
		const source = map!.getSource('country-hexes') as any;
		if (source) source.setData(hexGeoJSON);
		return h3;
	}

	function setupInteractions() {
		if (!map) return;
		map.on('mousedown', (e: any) => {
			const h3 = getHexAtPoint(e.point, e.lngLat);
			if (h3) {
				applyBrush(h3);
				if (tool !== 'pick') {
					isPainting = true;
					map!.dragPan.disable();
				}
			}
		});
		map.on('mousemove', (e: any) => {
			const h3Raw = latLngToCell(e.lngLat.lat, e.lngLat.lng, H3_RES);
			const isLand = landHexSet.has(h3Raw);
			const provId = hexToProvince[h3Raw];
			const provName = provId ? provinces[provId]?.name : null;
			hoveredHexId = `${h3Raw} ${isLand ? '(land)' : '(ocean)'}${provName ? ' · ' + provName : ''}`;
			const h3 = getHexAtPoint(e.point, e.lngLat);
			map!.getCanvas().style.cursor = h3 ? (tool === 'pick' ? 'pointer' : 'crosshair') : '';
			if (isPainting && h3) applyBrush(h3);
		});
		map.on('mouseup', () => {
			if (isPainting) {
				isPainting = false;
				map!.dragPan.enable();
				dataVersion++;
			}
		});
		map.getCanvas().addEventListener('contextmenu', (e: any) => e.preventDefault());
	}

	function applyBrush(h3: string) {
		if (!map) return;

		if (tool === 'pick') {
			const provId = hexToProvince[h3];
			if (editorMode === 'province') {
				if (provId) selectedProvince = provId;
			} else {
				if (provId && provinceToCountry[provId]) selectedCountry = provinceToCountry[provId];
				else if (provId) selectedProvince = provId; // no country — show province
			}
			return;
		}

		if (editorMode === 'province') {
			if (tool === 'paint' && selectedProvince) {
				hexToProvince[h3] = selectedProvince;
				const prov = provinces[selectedProvince];
				if (prov) {
					map.setFeatureState({ source: 'country-hexes', id: h3 },
						{ painted: true, fill: prov.color, borderColor: darkenColor(prov.color) });
				}
			} else if (tool === 'erase') {
				delete hexToProvince[h3];
				map.removeFeatureState({ source: 'country-hexes', id: h3 });
			}
		} else {
			// Country mode — paint entire province at once
			if (tool === 'paint' && selectedCountry) {
				const provId = hexToProvince[h3];
				if (!provId) return; // hex must belong to a province first
				provinceToCountry[provId] = selectedCountry;
				// Color all hexes in this province
				const country = countries[selectedCountry];
				if (!country) return;
				for (const [hex, pid] of Object.entries(hexToProvince)) {
					if (pid === provId) {
						map.setFeatureState({ source: 'country-hexes', id: hex },
							{ painted: true, fill: country.fill, borderColor: country.border });
					}
				}
			} else if (tool === 'erase') {
				const provId = hexToProvince[h3];
				if (provId) {
					delete provinceToCountry[provId];
					// Reset to province color
					const prov = provinces[provId];
					if (prov) {
						for (const [hex, pid] of Object.entries(hexToProvince)) {
							if (pid === provId) {
								map.setFeatureState({ source: 'country-hexes', id: hex },
									{ painted: true, fill: prov.color, borderColor: darkenColor(prov.color) });
							}
						}
					}
				}
			}
		}
	}

	// ── Province Management ──────────────────────────────────────
	function addProvince() {
		const id = `prov_${nextProvinceId++}`;
		const name = newItemName.trim() || id;
		const color = PROVINCE_PALETTE[(Object.keys(provinces).length) % PROVINCE_PALETTE.length];
		provinces[id] = { name, color };
		provinces = provinces;
		newItemName = '';
		newItemCode = '';
		showAddForm = false;
		selectedProvince = id;
		tool = 'paint';
		dataVersion++;
	}

	function deleteProvince(id: string) {
		const count = hexesByProvince[id] || 0;
		if (count > 0 && !confirm(`Delete "${provinces[id].name}"? This will unassign ${count} hexes.`)) return;
		for (const [h3, pid] of Object.entries(hexToProvince)) {
			if (pid === id) { delete hexToProvince[h3]; map?.removeFeatureState({ source: 'country-hexes', id: h3 }); }
		}
		delete provinceToCountry[id];
		delete provinces[id];
		provinces = provinces;
		if (selectedProvince === id) selectedProvince = null;
		dataVersion++;
	}

	// ── Country Management ──────────────────────────────────────
	function addCountry() {
		const code = newItemCode.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
		const name = newItemName.trim();
		if (!code || !name || countries[code]) return;
		const fill = randomColor();
		countries[code] = { name, fill, border: darkenColor(fill) };
		countries = countries;
		newItemName = '';
		newItemCode = '';
		showAddForm = false;
		selectedCountry = code;
		tool = 'paint';
	}

	function deleteCountry(code: string) {
		// Remove all province→country assignments for this country
		for (const [pid, c] of Object.entries(provinceToCountry)) {
			if (c === code) delete provinceToCountry[pid];
		}
		delete countries[code];
		countries = countries;
		if (selectedCountry === code) selectedCountry = null;
		dataVersion++;
		refreshMapColors();
	}

	function onColorChange(code: string, type: 'fill' | 'border', value: string) {
		countries[code][type] = value;
		countries = countries;
		refreshMapColors();
	}

	function onProvinceColorChange(id: string, value: string) {
		provinces[id].color = value;
		provinces = provinces;
		if (editorMode === 'province') refreshMapColors();
	}

	function toggleGrid() {
		showGrid = !showGrid;
		if (map) map.setLayoutProperty('country-hex-border', 'visibility', showGrid ? 'visible' : 'none');
	}

	function toggleBorders() {
		showBorders = !showBorders;
		if (map) map.setLayoutProperty('country-borders', 'visibility', showBorders ? 'visible' : 'none');
	}

	function toggleHexBorders() {
		showHexBorders = !showHexBorders;
		if (map) {
			// Toggle border visibility only for painted hexes by changing opacity
			map.setPaintProperty('country-hex-border', 'line-opacity',
				showHexBorders
					? ['interpolate', ['linear'], ['zoom'], 2, 0, 3, 0.3, 5, 0.6]
					: 0
			);
		}
	}

	function toggleStates() {
		showStates = !showStates;
		if (map) map.setLayoutProperty('state-borders', 'visibility', showStates ? 'visible' : 'none');
	}

	function switchMode(mode: 'province' | 'country') {
		editorMode = mode;
		showAddForm = false;
		refreshMapColors();
	}

	// ── Antimeridian fix ────────────────────────────────────────
	function fixAntiMeridian(geojson: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
		return { ...geojson, features: geojson.features.map((f) => {
			if (!f.geometry) return f;
			if (String(f.id) === '010') return { ...f, geometry: { type: 'Polygon' as const, coordinates: [[[-180,-60],[180,-60],[180,-90],[-180,-90],[-180,-60]]] } };
			const fix = (coords: number[][]) => {
				let hasNeg = false, hasPos = false;
				for (const c of coords) { if (c[0] < -20) hasNeg = true; if (c[0] > 160) hasPos = true; }
				if (hasNeg && hasPos) return coords.map((c) => (c[0] < 0 ? [c[0]+360,c[1]] : c));
				return coords;
			};
			if (f.geometry.type === 'Polygon') return { ...f, geometry: { ...f.geometry, coordinates: (f.geometry as GeoJSON.Polygon).coordinates.map(fix) } };
			if (f.geometry.type === 'MultiPolygon') return { ...f, geometry: { ...f.geometry, coordinates: (f.geometry as GeoJSON.MultiPolygon).coordinates.map(ring => ring.map(fix)) } };
			return f;
		})};
	}

	// ── Utility ─────────────────────────────────────────────────
	function randomColor(): string {
		const r = Math.floor(Math.random() * 128 + 80);
		const g = Math.floor(Math.random() * 128 + 80);
		const b = Math.floor(Math.random() * 128 + 80);
		return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
	}
	function darkenColor(hex: string): string {
		const r = Math.max(0, parseInt(hex.slice(1,3),16) - 50);
		const g = Math.max(0, parseInt(hex.slice(3,5),16) - 50);
		const b = Math.max(0, parseInt(hex.slice(5,7),16) - 50);
		return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
	}
</script>

<svelte:head>
	<title>Country Painter — Oceanliners</title>
	<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Source+Sans+3:wght@300;400;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div class="flex h-screen overflow-hidden" style="font-family: 'Source Sans 3', sans-serif;">
	<aside class="w-72 flex flex-col bg-[#2A2520] text-[#E8DFD0] border-r border-[rgba(255,255,255,0.08)]">
		<!-- Header -->
		<div class="px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
			<h1 class="text-lg text-[#C4A96A] font-semibold" style="font-family: 'Cormorant Garamond', Georgia, serif;">
				Country Painter
			</h1>
			<p class="text-[10px] text-[#A09890] mt-0.5">H3 Resolution 4 · ~45km hexes</p>
		</div>

		<!-- Mode Toggle -->
		<div class="px-3 py-2 border-b border-[rgba(255,255,255,0.08)]">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Mode</div>
			<div class="flex gap-1.5">
				<button class="tool-btn flex-1" class:active={editorMode === 'province'} onclick={() => switchMode('province')}>Province</button>
				<button class="tool-btn flex-1" class:active={editorMode === 'country'} onclick={() => switchMode('country')}>Country</button>
			</div>
		</div>

		<!-- Tools -->
		<div class="px-3 py-2 border-b border-[rgba(255,255,255,0.08)]">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Tools</div>
			<div class="flex gap-1.5 flex-wrap">
				<button class="tool-btn" class:active={tool === 'paint'} onclick={() => (tool = 'paint')}>Paint</button>
				<button class="tool-btn" class:active={tool === 'erase'} onclick={() => (tool = 'erase')}>Erase</button>
				<button class="tool-btn" class:active={tool === 'pick'} onclick={() => (tool = 'pick')}>Pick</button>
				<button class="tool-btn" class:active={showGrid} onclick={toggleGrid}>Grid</button>
				<button class="tool-btn" class:active={showBorders} onclick={toggleBorders}>Borders</button>
				<button class="tool-btn" class:active={showStates} onclick={toggleStates}>States</button>
				<button class="tool-btn" class:active={showHexBorders} onclick={toggleHexBorders}>Hex Border</button>
			</div>
		</div>

		<!-- Province / Country List -->
		<div class="flex-1 overflow-y-auto px-3 py-2">
			{#if editorMode === 'province'}
				<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Provinces</div>
				{#each Object.entries(provinces) as [id, prov]}
					<button class="country-item" class:selected={selectedProvince === id}
						onclick={() => { selectedProvince = id; tool = 'paint'; }}>
						<span class="w-4 h-4 rounded-sm flex-shrink-0" style="background: {prov.color};"></span>
						<span class="flex-1 text-xs truncate">{prov.name}</span>
						<span class="text-[10px] text-[#A09890]">{hexesByProvince[id] || 0}</span>
					</button>
				{/each}

				{#if showAddForm}
					<div class="mt-2 p-2 bg-[#1E1B18] rounded space-y-1.5">
						<input type="text" placeholder="Province name" class="editor-input" bind:value={newItemName} />
						<div class="flex gap-1.5">
							<button class="action-btn flex-1" onclick={addProvince}>Add</button>
							<button class="action-btn flex-1 opacity-60" onclick={() => (showAddForm = false)}>Cancel</button>
						</div>
					</div>
				{:else}
					<button class="w-full mt-2 py-1.5 text-xs text-[#C4A96A] border border-dashed border-[#C4A96A]/30 rounded hover:bg-[#C4A96A]/10 transition-colors"
						onclick={() => (showAddForm = true)}>
						+ Add Province
					</button>
				{/if}
			{:else}
				<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Countries</div>
				{#each Object.entries(countries) as [code, country]}
					<button class="country-item" class:selected={selectedCountry === code}
						onclick={() => { selectedCountry = code; tool = 'paint'; }}>
						<span class="w-4 h-4 rounded-sm flex-shrink-0" style="background: {country.fill}; border: 1px solid {country.border};"></span>
						<span class="flex-1 text-xs truncate">{country.name}</span>
						<span class="text-[10px] text-[#A09890]">{provincesByCountry[code] || 0}</span>
					</button>
				{/each}

				{#if showAddForm}
					<div class="mt-2 p-2 bg-[#1E1B18] rounded space-y-1.5">
						<input type="text" placeholder="Country name" class="editor-input" bind:value={newItemName}
							oninput={() => { newItemCode = newItemName.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }} />
						<input type="text" placeholder="Code (auto)" class="editor-input" bind:value={newItemCode} />
						<div class="flex gap-1.5">
							<button class="action-btn flex-1" onclick={addCountry}>Add</button>
							<button class="action-btn flex-1 opacity-60" onclick={() => (showAddForm = false)}>Cancel</button>
						</div>
					</div>
				{:else}
					<button class="w-full mt-2 py-1.5 text-xs text-[#C4A96A] border border-dashed border-[#C4A96A]/30 rounded hover:bg-[#C4A96A]/10 transition-colors"
						onclick={() => (showAddForm = true)}>
						+ Add Country
					</button>
				{/if}
			{/if}
		</div>

		<!-- Selected Item Editor -->
		{#if editorMode === 'province' && selectedProvince && provinces[selectedProvince]}
			<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] space-y-2">
				<div class="text-[10px] uppercase tracking-wider text-[#A09890]">
					Province: {provinces[selectedProvince].name}
				</div>
				<div class="flex items-center gap-2">
					<label class="text-[10px] text-[#A09890] w-10">Color</label>
					<input type="color" value={provinces[selectedProvince].color}
						oninput={(e) => onProvinceColorChange(selectedProvince!, (e.target as HTMLInputElement).value)}
						class="color-picker" />
				</div>
				{#if provinceToCountry[selectedProvince]}
					<div class="text-[10px] text-[#6B6460]">
						Country: {countries[provinceToCountry[selectedProvince]]?.name || 'Unknown'}
					</div>
				{/if}
				<button class="text-[10px] text-[#B85C5C] hover:text-[#D47070] transition-colors"
					onclick={() => deleteProvince(selectedProvince!)}>Delete Province</button>
			</div>
		{:else if editorMode === 'country' && selectedCountry && countries[selectedCountry]}
			<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] space-y-2">
				<div class="text-[10px] uppercase tracking-wider text-[#A09890]">
					Selected: {countries[selectedCountry].name}
				</div>
				<div class="flex items-center gap-2">
					<label class="text-[10px] text-[#A09890] w-10">Fill</label>
					<input type="color" value={countries[selectedCountry].fill}
						oninput={(e) => onColorChange(selectedCountry!, 'fill', (e.target as HTMLInputElement).value)}
						class="color-picker" />
					<span class="text-[10px] text-[#6B6460] font-mono">{countries[selectedCountry].fill}</span>
				</div>
				<div class="flex items-center gap-2">
					<label class="text-[10px] text-[#A09890] w-10">Border</label>
					<input type="color" value={countries[selectedCountry].border}
						oninput={(e) => onColorChange(selectedCountry!, 'border', (e.target as HTMLInputElement).value)}
						class="color-picker" />
					<span class="text-[10px] text-[#6B6460] font-mono">{countries[selectedCountry].border}</span>
				</div>
				<button class="text-[10px] text-[#B85C5C] hover:text-[#D47070] transition-colors"
					onclick={() => deleteCountry(selectedCountry!)}>Delete Country</button>
			</div>
		{/if}

		<!-- Actions -->
		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] flex gap-1.5">
			<button class="action-btn flex-1" onclick={exportData}>Export JSON</button>
			<button class="action-btn flex-1" onclick={() => importInput.click()}>Import JSON</button>
			<input type="file" bind:this={importInput} class="hidden" accept=".json" onchange={importData} />
		</div>

		<!-- Stats -->
		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] text-[10px] text-[#A09890]">
			{Object.keys(hexToProvince).length} hexes · {provinceCount} provinces · {Object.keys(countries).length} countries
			{#if hoveredHexId}<br/><span class="font-mono text-[9px]">{hoveredHexId}</span>{/if}
		</div>
	</aside>

	<main class="flex-1 relative">
		<div bind:this={mapContainer} class="w-full h-full"></div>
		{#if loading}
			<div class="absolute inset-0 flex flex-col items-center justify-center bg-[#1E1B18]/90 z-10">
				<div class="text-xl text-[#C4A96A] mb-2" style="font-family: 'Cormorant Garamond', Georgia, serif;">Country Painter</div>
				<div class="text-sm text-[#A09890]">{loadingMessage}</div>
				<div class="mt-4 w-48 h-1 bg-[#3A3530] rounded overflow-hidden">
					<div class="h-full bg-[#C4A96A] rounded loading-bar"></div>
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.tool-btn { padding: 4px 12px; font-size: 11px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #a09890; cursor: pointer; transition: all 0.15s; }
	.tool-btn:hover { background: rgba(196,169,106,0.1); color: #e8dfd0; }
	.tool-btn.active { background: rgba(196,169,106,0.2); border-color: #c4a96a; color: #c4a96a; }
	.country-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 6px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: #e8dfd0; cursor: pointer; transition: all 0.15s; text-align: left; }
	.country-item:hover { background: rgba(255,255,255,0.05); }
	.country-item.selected { background: rgba(196,169,106,0.15); border-color: rgba(196,169,106,0.3); }
	.editor-input { width: 100%; padding: 4px 8px; font-size: 11px; background: #2a2520; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #e8dfd0; outline: none; }
	.editor-input:focus { border-color: #c4a96a; }
	.action-btn { padding: 5px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 4px; border: 1px solid rgba(196,169,106,0.3); background: rgba(196,169,106,0.1); color: #c4a96a; cursor: pointer; transition: all 0.15s; }
	.action-btn:hover { background: rgba(196,169,106,0.2); border-color: #c4a96a; }
	.color-picker { width: 28px; height: 22px; padding: 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; cursor: pointer; background: transparent; }
	.color-picker::-webkit-color-swatch-wrapper { padding: 1px; }
	.color-picker::-webkit-color-swatch { border: none; border-radius: 2px; }
	.loading-bar { animation: loading 2s ease-in-out infinite; }
	@keyframes loading { 0% { width: 5%; } 50% { width: 70%; } 100% { width: 5%; } }
</style>
