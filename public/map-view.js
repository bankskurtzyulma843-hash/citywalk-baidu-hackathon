// JSAPI 4.0 exposes window.BMap, rather than the older GL namespace BMapGL.
// https://lbs.baidu.com/docs/jsapi?title=jsapi4/guide/concepts/load
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgNode = (name, attrs = {}, content) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = String(content);
  return node;
};

let loader;
let configuredCoordSystem;
export function normalizeCoordSystem(value) {
  const coordinateSystem = String(value || '').toUpperCase().replace(/[-_]/g, '');
  if (coordinateSystem === 'GCJ02') return 'GCJ02';
  if (coordinateSystem === 'BD09' || coordinateSystem === 'BD09LL') return 'BD09LL';
  return null;
}
export function coordinateSystemForMode(mode) { return mode === 'agentplan' ? 'GCJ02' : 'BD09LL'; }
function loadBaidu(ak) {
  if (window.BMap?.Map) return Promise.resolve(window.BMap);
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const callback = `cityWalkMapReady${Date.now()}`;
    const script = document.createElement('script');
    const finish = (error) => {
      clearTimeout(timer);
      window[callback] = () => {};
      if (error) { script.remove(); loader = undefined; reject(error); }
      else resolve(window.BMap);
    };
    const timer = setTimeout(() => finish(new Error('百度地图加载超时。请检查网络、浏览器 AK 和域名授权。')), 15000);
    window[callback] = () => window.BMap?.Map ? finish() : finish(new Error('百度地图未返回有效的地图接口，请检查 AK 配置。'));
    script.src = `https://api.map.baidu.com/api?v=4.0&ak=${encodeURIComponent(ak)}&callback=${callback}`;
    script.async = true;
    script.onerror = () => finish(new Error('无法连接百度地图，请检查网络或浏览器拦截设置。'));
    document.head.append(script);
  });
  return loader;
}

export class MapView {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.mode = null;
    this.stops = [];
    this.route = null;
    this.selectedId = null;
    this.loadGeneration = 0;
  }

  async initialize(mode, ak) {
    this.clearHostedMap();
    const generation = ++this.loadGeneration;
    this.mode = mode;
    this.coordSystem = coordinateSystemForMode(mode);
    this.map = null;
    this.container.replaceChildren();
    if (mode === 'demo') { this.render(); return; }
    if (!ak) throw new Error(mode === 'agentplan' ? 'AgentPlan 可用于地点检索与算路，但真实底图仍需要浏览器端 AK。SK 不能加载底图；当前只展示真实清单与时间，不显示模拟地图。' : '真实底图尚未配置浏览器端 AK。地点清单仍可使用；当前不显示模拟地图。');
    const BMap = await loadBaidu(ak);
    if (generation !== this.loadGeneration) return;
    if (this.requiresReload(mode)) throw new Error('数据来源的坐标系已改变，请刷新页面后加载新地图，避免地点和路线发生偏移。');
    if (!configuredCoordSystem) {
      // JSAPI's coordinate default is global and must not change after a map is created.
      // https://lbs.baidu.com/docs/jsapi?title=jsapi4/guide/map/gcj02
      if (this.coordSystem === 'GCJ02') {
        if (window.BMAP_COORD_GCJ02 === undefined) throw new Error('地图接口没有返回 GCJ02 坐标能力，无法准确展示 AgentPlan 地点。');
        BMap.coordType = window.BMAP_COORD_GCJ02;
      }
      configuredCoordSystem = this.coordSystem;
    }
    this.BMap = BMap;
    this.map = new BMap.Map(this.container);
    this.map.centerAndZoom(new BMap.Point(...(this.coordSystem === 'GCJ02' ? [116.397, 39.908] : [116.404, 39.915])), 14);
    this.map.enableScrollWheelZoom(true);
    this.map.enableDragging();
    this.render();
    // Do not treat a constructed map object as proof that its base tiles loaded.
    const map = this.map;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { map.removeEventListener('tilesloaded', ready); reject(new Error('百度底图未能加载。请检查浏览器 AK 的 JSAPI 权限、域名授权与网络。')); }, 12000);
      const ready = () => { clearTimeout(timer); map.removeEventListener('tilesloaded', ready); resolve(); };
      map.addEventListener('tilesloaded', ready);
    });
  }

  requiresReload(mode) { return mode !== 'demo' && Boolean(configuredCoordSystem && configuredCoordSystem !== coordinateSystemForMode(mode)); }

  clearHostedMap() {
    clearTimeout(this.hostedTimer);
    this.hostedGeneration = (this.hostedGeneration || 0) + 1;
    this.hostedFrame?.remove();
    this.hostedFrame = null;
    this.hostedUrl = null;
  }

  showHostedMap(url, label, onStatus, force = false) {
    if (!force && this.hostedUrl === url && this.hostedFrame) return;
    this.clearHostedMap();
    const generation = this.hostedGeneration;
    // Use the other loopback hostname to keep the official viewer in a separate
    // origin while preserving the storage APIs required by its map SDK.
    this.loadGeneration++;
    this.map = null;
    this.hostedUrl = url;
    const frame = document.createElement('iframe');
    frame.className = 'official-map-frame';
    frame.title = `百度地图官方托管视图：${label}`;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    frame.addEventListener('load', () => {
      if (generation !== this.hostedGeneration) return;
      clearTimeout(this.hostedTimer);
      // Cross-origin load confirms the document loaded, not that every map tile rendered.
      onStatus('document-loaded');
    });
    frame.addEventListener('error', () => {
      if (generation !== this.hostedGeneration) return;
      clearTimeout(this.hostedTimer);
      onStatus('failed');
    });
    this.hostedTimer = setTimeout(() => { if (generation === this.hostedGeneration) onStatus('failed'); }, 15000);
    this.hostedFrame = frame;
    const embed = new URL('/api/v1/maps/embed', window.location.origin);
    embed.hostname = window.location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    embed.searchParams.set('resource_key', new URL(url).searchParams.get('resource_key'));
    frame.src = embed.href;
    // Attach the frame with its intended URL, avoiding an initial blank navigation.
    this.container.replaceChildren(frame);
    onStatus('loading');
  }

  async currentLocation() {
    if (this.mode !== 'agentplan' || !this.map || this.coordSystem !== 'GCJ02' || configuredCoordSystem !== 'GCJ02' || !this.BMap?.Geolocation) throw new Error('AgentPlan 算路需要真实当前位置。请先配置浏览器 AK 并加载地图后定位；不能用第一站代替当前位置。');
    if (!window.isSecureContext || !navigator.geolocation) throw new Error('当前浏览器无法精确定位，请使用 HTTPS 或本机 localhost，并允许位置访问。');
    // Require an actual browser position before the SDK can fall back to IP.
    // The SDK then performs the documented global-GCJ02 coordinate handling.
    // https://lbs.baidu.com/docs/jsapi?title=jsapi4/guide/map/gcj02
    // https://lbs.baidu.com/jsapi/refdoc/v4/classes/BMap.Geolocation.html
    const native = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, error => reject(new Error(error.code === 1 ? '定位授权被拒绝。AgentPlan 算路需要你的真实当前位置，未发送路线请求。' : error.code === 3 ? '当前位置获取超时，请重试；未用地图中心或首站代替定位。' : '无法获取真实当前位置，请检查设备定位设置。')), { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }));
    if (!Number.isFinite(native.coords?.longitude) || !Number.isFinite(native.coords?.latitude) || !Number.isFinite(native.coords?.accuracy) || native.coords.accuracy > 500) throw new Error('当前位置精度不足，不能用城市级定位算路。请开启设备精确定位后重试。');
    const geolocation = new this.BMap.Geolocation();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GCJ02 当前位置获取超时，请稍后重试。')), 12000);
      geolocation.getCurrentPosition(result => {
        clearTimeout(timer);
        if (geolocation.getStatus() !== 0 || !Number.isFinite(result?.point?.lng) || !Number.isFinite(result?.point?.lat) || !Number.isFinite(result?.accuracy) || result.accuracy > 500) { reject(new Error('未能取得可用的精确 GCJ02 当前位置，AgentPlan 路线请求未发送。')); return; }
        if (Math.abs(result.point.lng - native.coords.longitude) > 0.02 || Math.abs(result.point.lat - native.coords.latitude) > 0.02) { reject(new Error('地图定位与设备当前位置不一致，请重试，未使用城市中心点替代定位。')); return; }
        resolve({ lng: result.point.lng, lat: result.point.lat, coordSystem: 'GCJ02', accuracyM: result.accuracy, source: 'browser-and-baidu-geolocation', capturedAt: new Date().toISOString() });
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000, SDKLocation: false });
    });
  }

  update(stops, route, selectedId) {
    this.stops = stops;
    this.route = route;
    this.selectedId = selectedId;
    this.render();
  }

  fit() {
    if (this.mode === 'demo') { this.render(); return; }
    if (this.map && this.stops.length) this.map.setViewport(this.stops.map(stop => this.point(stop.location)));
  }

  focus(placeId) {
    this.selectedId = placeId;
    this.render();
    const stop = this.stops.find(item => item.placeId === placeId);
    if (stop && this.map) this.map.panTo(this.point(stop.location));
  }

  point(location, inheritedCoordSystem) {
    const coordSystem = normalizeCoordSystem(location.coordSystem || inheritedCoordSystem || this.coordSystem);
    if (coordSystem !== this.coordSystem) throw new Error('地点或路线坐标与当前地图不一致，已停止绘制以避免位置偏移。');
    return new this.BMap.Point(location.lng, location.lat);
  }

  render() {
    if (this.hostedUrl) return;
    if (this.mode === 'demo') this.renderSchematic();
    else if (this.map) this.renderBaidu();
  }

  renderBaidu() {
    const BMap = this.BMap;
    this.map.clearOverlays();
    for (const segment of this.route?.segments || []) {
      if (!Array.isArray(segment.path) || segment.path.length < 2) continue;
      this.map.addOverlay(new BMap.Polyline(segment.path.map(point => this.point(point, segment.coordSystem || this.route.coordSystem)), { strokeColor: '#ee896b', strokeWeight: 6, strokeOpacity: 0.92 }));
    }
    this.stops.forEach((stop, index) => {
      // Only a locally generated number enters Label's HTML-capable content.
      const label = new BMap.Label(String(index + 1), { position: this.point(stop.location), offset: new BMap.Size(-15, -15) });
      label.setStyle({ backgroundColor: stop.placeId === this.selectedId ? '#ee896b' : '#244c3d', color: '#fffef9', border: '3px solid #fffef9', borderRadius: '50%', width: '30px', height: '30px', lineHeight: '24px', textAlign: 'center', fontSize: '12px', fontWeight: 'bold', boxShadow: '0 2px 8px #244c3d30', cursor: 'pointer' });
      label.addEventListener('click', () => this.onSelect(stop.placeId));
      this.map.addOverlay(label);
    });
  }

  renderSchematic() {
    const svg = svgNode('svg', { viewBox: '0 0 1000 800', class: 'schematic-map', role: 'img', 'aria-label': '演示街区示意图。地点和路线为演示数据，不代表真实道路。' });
    svg.append(svgNode('rect', { width: 1000, height: 800, fill: '#edf0e7' }));
    const blocks = svgNode('g', { transform: 'rotate(-12 500 400)' });
    for (let row = -1; row < 8; row++) {
      for (let col = -1; col < 10; col++) {
        blocks.append(svgNode('rect', { x: col * 145 + 21, y: row * 123 + 22, width: 122, height: 100, rx: 8, fill: (row + col) % 4 === 0 ? '#e2e7db' : '#e6eadf' }));
      }
    }
    for (let row = -1; row < 9; row++) blocks.append(svgNode('path', { d: `M -200 ${row * 123 + 10} H 1300`, fill: 'none', stroke: '#fffef8', 'stroke-width': row % 3 === 0 ? 16 : 9 }));
    for (let col = -1; col < 11; col++) blocks.append(svgNode('path', { d: `M ${col * 145 + 11} -200 V 1100`, fill: 'none', stroke: '#fffef8', 'stroke-width': col % 3 === 0 ? 16 : 9 }));
    svg.append(blocks);
    svg.append(svgNode('path', { d: 'M750,-50 C660,70 755,135 825,218 S740,378 860,470 S900,650 1010,860', fill: 'none', stroke: '#d1e0d8', 'stroke-width': 45 }));
    svg.append(svgNode('path', { d: 'M750,-50 C660,70 755,135 825,218 S740,378 860,470 S900,650 1010,860', fill: 'none', stroke: '#e0ebe5', 'stroke-width': 29 }));
    svg.append(svgNode('rect', { x: 125, y: 472, width: 195, height: 132, rx: 36, fill: '#d9e4ce', transform: 'rotate(-12 220 530)' }));
    svg.append(svgNode('rect', { x: 530, y: 145, width: 180, height: 142, rx: 28, fill: '#d9e4ce', transform: 'rotate(-12 620 210)' }));
    svg.append(svgNode('text', { x: 219, y: 539, fill: '#9bac96', 'font-size': 12, 'letter-spacing': 5, 'text-anchor': 'middle', transform: 'rotate(-12 220 530)' }, '绿地示意'));
    svg.append(svgNode('text', { x: 620, y: 215, fill: '#9bac96', 'font-size': 12, 'letter-spacing': 5, 'text-anchor': 'middle', transform: 'rotate(-12 620 210)' }, '街区示意'));
    const allPoints = [...this.stops.map(stop => stop.location), ...(this.route?.segments || []).flatMap(segment => segment.path)];
    const lngs = allPoints.map(point => point.lng);
    const lats = allPoints.map(point => point.lat);
    const minLng = allPoints.length ? Math.min(...lngs) : 116.39;
    const maxLng = allPoints.length ? Math.max(...lngs) : 116.42;
    const minLat = allPoints.length ? Math.min(...lats) : 39.92;
    const maxLat = allPoints.length ? Math.max(...lats) : 39.95;
    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const spanLng = Math.max(maxLng - minLng, 0.008) * 1.35;
    const spanLat = Math.max(maxLat - minLat, 0.008) * 1.35;
    const project = point => ({ x: 500 + (point.lng - centerLng) / spanLng * 670, y: 420 - (point.lat - centerLat) / spanLat * 450 });
    for (const segment of this.route?.segments || []) {
      const points = segment.path.map(point => { const p = project(point); return `${p.x},${p.y}`; }).join(' ');
      svg.append(svgNode('polyline', { points, fill: 'none', stroke: '#fffef9', 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      svg.append(svgNode('polyline', { points, fill: 'none', stroke: '#ee896b', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '10 5' }));
    }
    this.stops.forEach((stop, index) => {
      const point = project(stop.location);
      const group = svgNode('g', { class: `schematic-stop${stop.placeId === this.selectedId ? ' selected' : ''}`, transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'aria-label': `第 ${index + 1} 站，${stop.name}` });
      group.append(svgNode('circle', { r: 25, fill: '#244c3d10' }));
      group.append(svgNode('circle', { r: 18, fill: '#244c3d', stroke: '#fffef9', 'stroke-width': 4, class: 'pin' }));
      group.append(svgNode('text', { y: 5, fill: '#fffef9', 'font-size': 13, 'font-weight': 650, 'text-anchor': 'middle' }, index + 1));
      const width = Math.min(stop.name.length * 13 + 22, 260);
      group.append(svgNode('rect', { x: -width / 2, y: 30, width, height: 29, rx: 6, fill: '#fffef9', stroke: '#e1e6d9' }));
      group.append(svgNode('text', { x: 0, y: 49, fill: '#244c3d', 'font-size': 12, 'text-anchor': 'middle' }, stop.name.length > 18 ? `${stop.name.slice(0, 18)}…` : stop.name));
      group.addEventListener('click', () => this.onSelect(stop.placeId));
      group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.onSelect(stop.placeId); } });
      svg.append(group);
    });
    if (!this.stops.length) {
      svg.append(svgNode('circle', { cx: 440, cy: 410, r: 47, fill: '#fffef9cc' }));
      svg.append(svgNode('text', { x: 440, y: 424, fill: '#ee896b', 'font-size': 42, 'text-anchor': 'middle' }, '↗'));
      svg.append(svgNode('text', { x: 440, y: 490, fill: '#789078', 'font-size': 13, 'text-anchor': 'middle', 'letter-spacing': 5 }, '从第一站，开始探索'));
    }
    this.container.replaceChildren(svg);
  }
}
