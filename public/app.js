import { MapView, normalizeCoordSystem, coordinateSystemForMode } from './map-view.js';
import { bindMapusZoomControls } from './mapus-assets/mapus-controls.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'citywalk.localDraft.v1';
const shareMatch = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
const state = {
  readonly: Boolean(shareMatch), config: null, mode: 'demo', city: '北京', stops: [], budgetMin: 180,
  route: null, routeMeta: null, results: [], selectedId: null, revision: 0, routeRequest: 0,
  routeBusy: false, searchRequest: 0, searchBusy: false, mapGeneration: 0,
  shareBusy: false, shareSnapshot: null, configFailed: false,
  serviceStatus: {}, mapLoaded: false, searchMapUrl: null,
  hostedMap: false, officialFrameStatus: 'idle', officialViewIndex: 0,
  officialKind: 'search', planBusy: false, planRequest: 0,
  workspaceTab: 'discover', discoveryFilter: 'all', bootstrapAttempted: false, bootstrapBusy: false, bootstrapError: '',
};
const mapView = new MapView($('map'), selectStop);
let unbindZoom;
const dom = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const maxStops = () => state.config?.limits?.maxStops || 5;
const intValue = (value, fallback, min = 0, max = 1440) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const validPlace = place => Boolean(place && typeof place.placeId === 'string' && typeof place.name === 'string' && Number.isFinite(place.location?.lng) && Number.isFinite(place.location?.lat) && place.location.lng >= -180 && place.location.lng <= 180 && place.location.lat >= -90 && place.location.lat <= 90 && normalizeCoordSystem(place.location.coordSystem));
const normalizePlace = place => ({ ...place, location: { ...place.location, coordSystem: normalizeCoordSystem(place.location.coordSystem) } });
const placeMatchesMode = (place, mode = state.mode) => validPlace(place) && normalizeCoordSystem(place.location.coordSystem) === coordinateSystemForMode(mode) && (mode === 'demo' ? /demo|fixture|example/i.test(place.source || '') : !/demo|fixture|example/i.test(place.source || ''));
const minutes = seconds => Math.ceil(seconds / 60);
const distanceText = meters => meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 米`;
const modeName = mode => mode === 'agentplan' ? '百度地图 AgentPlan' : mode === 'cli' ? '百度地图 CLI' : '百度地图 API';
const placeSource = place => /demo|fixture|example/i.test(String(place.source)) || state.mode === 'demo' ? '示例地点 · 演示数据' : `${modeName(state.mode)} 地点数据`;

// These are themes to start a live query, not precomputed or rated routes.
const discoveries = [
  { title: '胡同里的咖啡时光', description: '一杯咖啡，一段不赶时间的散步。', city: '北京', category: 'coffee', tag: '咖啡小憩', photo: 'coffee-break.jpg', prompt: '北京雍和宫附近，2小时，胡同和咖啡，3站' },
  { title: '绕进五道营的小巷', description: '沿着老街，发现藏在转角的日常。', city: '北京', category: 'street', tag: '胡同漫步', photo: 'beijing-hutong.jpg', prompt: '北京五道营胡同附近，2小时，胡同和历史街区，3站' },
  { title: '在湖边慢慢走', description: '把脚步放轻，沿着水岸逛一逛。', city: '北京', category: 'nature', tag: '湖边散步', photo: 'houhai-lakeside.jpg', prompt: '北京什刹海附近，2小时，湖边散步和历史街区，3站' },
  { title: '武康路上的小发现', description: '树荫、街角，和一家想坐下的咖啡馆。', city: '上海', category: 'coffee', tag: '街区与咖啡', photo: 'shanghai-street.jpg', prompt: '上海武康路附近，2小时，街区和咖啡，3站' },
  { title: '老建筑之间散步', description: '从武康路出发，看看城市的另一面。', city: '上海', category: 'street', tag: '建筑与街角', photo: 'shanghai-architecture.jpg', prompt: '上海武康路附近，2小时，历史建筑和街区，3站' },
  { title: '古建旁的一小段路', description: '从雍和宫周边，走进安静的老街。', city: '北京', category: 'street', tag: '文化漫步', photo: 'beijing-temple.jpg', prompt: '北京雍和宫附近，2小时，古建和历史街区，3站' },
];

function themePhoto(place) {
  const name = place.name || '';
  if (/咖啡|coffee|cafe|café|SOE|EGG|METAL HANDS/i.test(name)) return 'coffee-break.jpg';
  if (/海|湖|公园|水岸/.test(name)) return 'houhai-lakeside.jpg';
  if (/雍和宫|寺|庙|孔庙|国子监/.test(name)) return 'beijing-temple.jpg';
  return /上海/.test(place.city || state.city) ? 'shanghai-street.jpg' : 'beijing-hutong.jpg';
}

function photoImage(file, className, alt) {
  const img = dom('img', className);
  img.src = `/photos/${file}`;
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  return img;
}

function showWorkspaceTab(tab) {
  state.workspaceTab = state.readonly ? 'route' : tab;
  $('route-section').closest('.planner').classList.toggle('route-view', state.workspaceTab === 'route');
  $('discover-section').hidden = state.workspaceTab !== 'discover';
  $('route-section').hidden = state.workspaceTab !== 'route';
  for (const name of ['discover', 'route']) {
    $(`${name}-tab`).classList.toggle('active', name === state.workspaceTab);
    $(`${name}-tab`).setAttribute('aria-pressed', String(name === state.workspaceTab));
  }
  $('summary-panel').hidden = !state.readonly && (state.workspaceTab !== 'route' || !state.stops.length);
}

function renderDiscovery() {
  $('discovery-grid').replaceChildren();
  for (const item of discoveries.filter(item => state.discoveryFilter === 'all' || item.category === state.discoveryFilter)) {
    const card = dom('article', 'discovery-card');
    const photo = dom('button', 'discovery-photo');
    photo.type = 'button';
    photo.dataset.planPrompt = item.prompt;
    photo.setAttribute('aria-label', `规划${item.title}：${item.city}，2小时，3站`);
    photo.append(photoImage(item.photo, '', `${item.tag}主题配图`), dom('span', 'discovery-tag', item.tag));
    const body = dom('div', 'discovery-copy');
    body.append(dom('h3', '', item.title), dom('p', 'discovery-description', item.description), dom('div', 'discovery-meta', `${item.city} · 2 小时 · 3 站`));
    const start = dom('button', 'discovery-start', '规划这条路线 ↗');
    start.type = 'button'; start.dataset.planPrompt = item.prompt;
    for (const button of [photo, start]) {
      button.disabled = !state.config || state.mode !== 'agentplan' || state.configFailed || state.planBusy || state.routeBusy;
      button.addEventListener('click', () => { $('plan-input').value = item.prompt; planWalk(item.prompt); });
    }
    body.append(start); card.append(photo, body); $('discovery-grid').append(card);
  }
}

function dataModeFor(meta, places = []) {
  if (meta?.provider === 'demo' || meta?.adapterMode === 'fixture' || places.some(place => /demo|fixture|example/i.test(place.source || ''))) return 'demo';
  if (meta?.adapterMode === 'agentplan' || /agent[-_]?plan/i.test(meta?.provider || '') || places.some(place => /agent[-_]?plan/i.test(place.source || ''))) return 'agentplan';
  if (meta?.adapterMode === 'cli') return 'cli';
  return 'baidu';
}

function trustedMapUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'lbs.baidu.com' || url.port || url.username || url.password || url.pathname !== '/mapstatic/agentui_resource.html' || !url.searchParams.get('resource_key')) return null;
    return url.href;
  } catch { return null; }
}

function officialMapViews() {
  if (state.mode !== 'agentplan') return [];
  const searches = state.searchMapUrl ? [{ url: state.searchMapUrl, kind: 'search', label: '此次搜索的地点地图' }] : [];
  let routeViews = [];
  if (state.route) {
    const segments = state.route.segments.map((segment, index) => {
      const url = trustedMapUrl(segment.mapUrl || segment.renderUrl || state.route.mapUrls?.[index]);
      return url ? { url, kind: 'route', label: `第 ${index + 1} → ${index + 2} 站步行路线` } : null;
    }).filter(Boolean);
    if (segments.length) {
      routeViews = segments;
      if (segments.length > 1) {
        const keys = segments.map(view => new URL(view.url).searchParams.get('resource_key'));
        if (keys.every(key => /^[a-f0-9]{32}$/i.test(key))) {
          // The official viewer accepts a comma-separated list and fits all
          // returned overlays together; use only actual keys from this route.
          const full = new URL(segments[0].url);
          full.searchParams.set('resource_key', [...new Set(keys)].join(','));
          routeViews.unshift({ url: full.href, kind: 'route', label: `全程步行路线 · ${state.stops.length} 站` });
        }
      }
    }
    else {
      const url = trustedMapUrl(state.route.mapUrl || state.route.renderUrl);
      if (url) routeViews = [{ url, kind: 'route', label: state.route.segments.length === 1 ? '第 1 → 2 站步行路线' : '百度返回的路线资源' }];
    }
  }
  return state.officialKind === 'search' ? [...searches, ...routeViews] : [...routeViews, ...searches];
}

function showMapMessage(title, message, isError = false) {
  $('map-error').hidden = false;
  $('map-error').querySelector('h2').textContent = title;
  $('map-error').querySelector('.error-symbol').textContent = isError ? '!' : '↗';
  $('map-error-text').textContent = message;
  $('retry-map').hidden = state.mode === 'agentplan' && !state.config?.browserAk;
}

function renderOfficialMap(force = false) {
  const views = officialMapViews();
  state.officialViewIndex = Math.min(state.officialViewIndex, Math.max(0, views.length - 1));
  const current = views[state.officialViewIndex];
  const wasHosted = state.hostedMap;
  state.hostedMap = Boolean(current);
  $('map').closest('.map-panel').classList.toggle('official-resource', state.hostedMap);
  $('official-map-toolbar').hidden = !current;
  $('upstream-map-link').hidden = !current;
  $('retry-official-map').hidden = !current;
  $('retry-official-map').disabled = state.planBusy || state.routeBusy;
  $('retry-official-map').textContent = state.officialFrameStatus === 'expired' ? '更新地图' : '重新加载';
  $('official-map-view').hidden = views.length < 2;
  $('official-map-view').replaceChildren(...views.map((view, index) => {
    const option = dom('option', '', view.label); option.value = String(index); return option;
  }));
  $('official-map-view').value = String(state.officialViewIndex);
  if (!current) {
    $('upstream-map-link').removeAttribute('href');
    if (wasHosted) {
      mapView.clearHostedMap();
      state.officialFrameStatus = 'idle';
      if (state.config?.browserAk) queueMicrotask(initializeMap);
    }
    if (state.mode === 'agentplan' && !state.config?.browserAk && !state.configFailed) {
      showMapMessage(state.bootstrapBusy ? `正在展开${state.city}地图` : state.bootstrapError ? '地图暂时无法展示' : '从这里，开始探索城市', state.bootstrapBusy ? '真实地点即将出现在地图上。你也可以先选一条喜欢的散步路线。' : state.bootstrapError || '选择左侧的路线卡片，或说一句今天想怎么逛。', Boolean(state.bootstrapError));
      $('retry-map').hidden = !state.bootstrapError;
    }
    return;
  }
  const needsResourceCheck = force || mapView.hostedUrl !== current.url;
  if (needsResourceCheck) state.officialFrameStatus = 'idle';
  state.mapLoaded = false;
  if (mapView.hostedUrl === current.url && state.officialFrameStatus === 'expired' && !force) showMapMessage('地图资源已过期，需要更新', state.readonly ? '原地图展示链接已过期，行程的地点与时间仍可查看。' : '重新生成路线或搜索地点，获取新的百度地图。', true);
  else if (mapView.hostedUrl === current.url && state.officialFrameStatus === 'failed' && !force) showMapMessage('官方地图暂时无法显示', '可以重新加载，或点“在百度地图查看”打开这次真实查询返回的地图。', true);
  else $('map-error').hidden = true;
  $('retry-map').hidden = true;
  $('upstream-map-link').href = current.url;
  $('fit-map').disabled = true;
  $('zoom-controls').hidden = true;
  $('source-badge').textContent = '百度地图 AgentPlan · 官方托管图';
  $('map-caption-text').textContent = current.label;
  mapView.showHostedMap(current.url, current.label, status => {
    if (mapView.hostedUrl !== current.url || state.officialFrameStatus === 'expired') return;
    state.officialFrameStatus = status;
    $('retry-official-map').textContent = '重新加载';
    $('hosted-map-status').textContent = status === 'loading' ? `正在加载 · ${current.label}` : status === 'document-loaded' ? `${current.label} · 百度官方页面` : '托管地图加载较慢，可重新加载或外部打开';
    if (status === 'failed') showMapMessage('官方地图暂时无法显示', '可以重新加载，或点“在百度地图查看”打开这次真实查询返回的地图。', true);
    else $('map-error').hidden = true;
    renderConnectionStatus();
  }, force);
  if (needsResourceCheck) {
    const resourceKey = new URL(current.url).searchParams.get('resource_key');
    api(`/api/v1/maps/resource-status?resource_key=${encodeURIComponent(resourceKey)}`).then(response => {
      if (mapView.hostedUrl !== current.url) return;
      if (response.data?.available === false && response.data.reason === 'expired') {
        state.officialFrameStatus = 'expired';
        $('retry-official-map').textContent = '更新地图';
        $('hosted-map-status').textContent = '这份百度地图资源已过期';
        showMapMessage('地图资源已过期，需要更新', state.readonly ? '百度返回的展示资源已过期。此行程的地点与时间仍可查看，原地图链接不再可用。' : '重新生成这条路线，或搜索地点，获取新的百度地图。刷新旧链接无法恢复地图。', true);
        renderConnectionStatus();
      }
    }).catch(() => {}); // Resource diagnostics must not stop usable map navigation.
  }
}

function renderConnectionStatus() {
  if (!state.config) return;
  $('connection-label').textContent = state.mode === 'demo' ? '示例地图' : state.serviceStatus[state.mode]?.search || state.serviceStatus[state.mode]?.route ? '百度地图已连接' : '百度地图';
  const connectionDescription = mode => {
    if (state.serviceStatus[mode]?.route) return '本页已成功获取步行路线';
    if (state.serviceStatus[mode]?.search) return '本页检索已连通；步行算路待验证';
    return state.config.capabilities?.[mode] ? '凭证已配置；查询连通性待验证' : mode === 'agentplan' ? '等待配置 AgentPlan SK' : '等待配置服务端 AK';
  };
  const mapDescription = state.hostedMap ? state.officialFrameStatus === 'expired' ? '官方展示资源已过期，地点与路线数据仍保留' : state.officialFrameStatus === 'document-loaded' ? '百度托管页面已载入，无需本地浏览器 AK' : state.officialFrameStatus === 'failed' ? '托管页面加载未确认，可外部打开' : '正在加载百度托管页面，无需本地浏览器 AK' : state.mapLoaded ? '本页 JSAPI 已加载' : state.config.browserAk ? '浏览器 AK 已配置；加载结果待验证' : '尚未加载；真实查询可使用百度托管地图';
  $('connection-details').replaceChildren(dom('p', '', `AgentPlan：${connectionDescription('agentplan')}`), dom('p', '', `传统百度 API：${connectionDescription('baidu')}`), dom('p', '', `地图：${mapDescription}`), dom('p', '', `CLI：${state.config.cliStatus?.installed ? `已检测 ${state.config.cliStatus.version || ''}` : '未安装'}`), dom('p', '', state.config.cliStatus?.reason || 'CLI 授权与地理查询能力待验证。'));
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('无法连接行程服务，请检查网络后重试。'); }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('服务返回了无法识别的内容，请稍后重试。'); }
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `请求失败（${response.status}），请稍后重试。`);
    error.code = payload.error?.code;
    error.retryable = payload.error?.retryable;
    error.requestId = payload.requestId;
    throw error;
  }
  return payload;
}

function notice(message, success = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('success', success);
  $('notice').hidden = !message;
}

function loadDraft() {
  if (state.readonly) return;
  try {
    const draft = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!draft || !Array.isArray(draft.orderedStops)) return;
    const configuredMode = state.config.mode;
    if (configuredMode !== 'demo' && draft.mode !== configuredMode && draft.configuredMode !== configuredMode) {
      notice(`当前已启用${modeName(configuredMode)}，旧${draft.mode === 'demo' ? '演示' : '其他来源'}草稿未自动载入，避免混用地点。`);
      $('draft-status').textContent = '旧草稿暂保留在本机，当前使用新的数据来源';
      return;
    }
    if (!['demo', 'baidu', 'agentplan'].includes(draft.mode) || (draft.mode !== 'demo' && !state.config.capabilities?.[draft.mode])) {
      notice('旧草稿的数据来源目前不可用，未自动载入。');
      return;
    }
    if (draft.orderedStops.some(place => !placeMatchesMode(place, draft.mode))) {
      notice('旧草稿包含坐标或来源不一致的地点，未自动载入，请重新搜索。');
      return;
    }
    state.city = typeof draft.city === 'string' && draft.city.trim() ? draft.city.slice(0, 30) : '北京';
    state.mode = draft.mode;
    state.stops = draft.orderedStops.slice(0, maxStops()).map(place => ({ ...normalizePlace(place), stayMin: intValue(place.stayMin, 20, 0, 240) }));
    state.budgetMin = intValue(draft.budgetMin, 180, 1);
    state.searchMapUrl = trustedMapUrl(draft.searchMapUrl);
    if (typeof draft.planningRequestText === 'string' && draft.planningRequestText.length <= 1000) $('plan-input').value = draft.planningRequestText;
    $('draft-status').textContent = state.stops.length ? '已恢复本机草稿 · 仅当前浏览器可编辑' : '草稿保存在当前浏览器';
  } catch {
    $('draft-status').textContent = '浏览器暂时无法读取草稿，仍可继续规划。';
  }
}

function saveDraft() {
  if (state.readonly) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ city: state.city, mode: state.mode, configuredMode: state.config.mode, orderedStops: state.stops, budgetMin: state.budgetMin, searchMapUrl: state.searchMapUrl, planningRequestText: $('plan-input').value }));
    $('draft-status').textContent = '草稿已保存在本机 · 仅当前浏览器可编辑';
  } catch {
    $('draft-status').textContent = '浏览器无法保存草稿。当前计划仍可使用，请避免刷新页面。';
  }
}

function invalidateRoute() {
  state.revision++;
  state.route = null;
  state.routeMeta = null;
  state.officialViewIndex = 0;
  $('share-result').hidden = true;
  $('share-error').hidden = true;
  $('share-dialog').close();
}

function selectStop(placeId) {
  state.selectedId = placeId;
  for (const item of $('stop-list').querySelectorAll('.stop-card')) item.classList.toggle('selected', item.dataset.placeId === placeId);
  mapView.focus(placeId);
  const selected = Array.from($('stop-list').querySelectorAll('.stop-card')).find(item => item.dataset.placeId === placeId);
  selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function addPlace(place) {
  if (state.readonly || !placeMatchesMode(place)) return;
  const existing = state.stops.find(stop => stop.placeId === place.placeId || (stop.providerPlaceId && stop.providerPlaceId === place.providerPlaceId));
  if (existing) { selectStop(existing.placeId); notice('这个地点已经在清单里了。'); return; }
  if (state.stops.length >= maxStops()) { notice(`这个 Demo 最多安排 ${maxStops()} 站，先减少一站再加入。`); return; }
  state.stops.push({ ...place, stayMin: 20 });
  state.selectedId = place.placeId;
  invalidateRoute();
  saveDraft();
  notice('已加入清单。整理好顺序后，点击生成步行路线。', true);
  showWorkspaceTab('route');
  render();
  mapView.fit();
}

function updateGeometry(action) {
  if (state.readonly) return;
  action();
  invalidateRoute();
  saveDraft();
  render();
  notice(state.stops.length ? '行程已修改，重新生成路线后才能分享。' : '清单已清空，可以开始新的散步计划。', !state.stops.length);
}

function renderResults() {
  const container = $('search-results');
  container.replaceChildren();
  for (const place of state.results) {
    const row = dom('article', 'search-result');
    const content = dom('div', 'search-result-content');
    content.append(dom('h3', '', place.name), dom('p', '', place.address || '地址暂未提供'), dom('p', '', placeSource(place)));
    const button = dom('button', '', state.stops.some(stop => stop.placeId === place.placeId) ? '已加入' : '+ 加入');
    button.type = 'button';
    button.disabled = state.planBusy || !placeMatchesMode(place) || state.stops.some(stop => stop.placeId === place.placeId);
    button.addEventListener('click', () => addPlace(place));
    row.append(photoImage(themePhoto(place), 'search-result-photo', '地点主题配图，并非商户实景'), content, button);
    container.append(row);
  }
}

function makeStopCard(stop, index) {
  const card = dom('li', `stop-card${stop.placeId === state.selectedId ? ' selected' : ''}`);
  card.dataset.placeId = stop.placeId;
  card.append(dom('span', 'stop-number', index + 1));
  card.append(photoImage(themePhoto(stop), 'route-photo', '地点主题配图，并非商户实景'));
  const body = dom('div', 'stop-body');
  const title = dom('button', 'stop-title', stop.name);
  title.type = 'button';
  title.title = state.mode === 'agentplan' ? '选中这个地点；百度托管图中的视图独立展示' : '在地图上查看这个地点';
  title.addEventListener('click', () => selectStop(stop.placeId));
  body.append(title, dom('p', 'stop-address', stop.address || '地址暂未提供'));
  const toolbar = dom('div', 'stop-toolbar');
  const stay = dom('label', 'stop-stay');
  stay.append(dom('span', '', '停留'));
  if (state.readonly) stay.append(dom('span', '', `${stop.stayMin} 分钟`));
  else {
    const input = dom('input');
    input.type = 'number'; input.min = '0'; input.max = '240'; input.step = '1'; input.value = stop.stayMin;
    input.disabled = state.planBusy;
    input.setAttribute('aria-label', `${stop.name}的停留分钟数`);
    input.addEventListener('change', () => {
      const next = intValue(input.value, -1, 0, 240);
      if (next < 0) { input.value = stop.stayMin; notice('停留时间请输入 0–240 的整数分钟。'); return; }
      stop.stayMin = next;
      saveDraft();
      renderSummary();
      if (!state.routeBusy) notice('停留时间已更新，无需重新算路。', true);
    });
    stay.append(input, dom('span', '', '分钟'));
  }
  toolbar.append(stay);
  if (!state.readonly) {
    const controls = dom('div', 'stop-controls');
    for (const [text, label, disabled, action] of [
      ['↑', `将${stop.name}上移一站`, index === 0, () => [state.stops[index - 1], state.stops[index]] = [state.stops[index], state.stops[index - 1]]],
      ['↓', `将${stop.name}下移一站`, index === state.stops.length - 1, () => [state.stops[index], state.stops[index + 1]] = [state.stops[index + 1], state.stops[index]]],
      ['×', `移除${stop.name}`, false, () => { state.stops.splice(index, 1); if (state.selectedId === stop.placeId) state.selectedId = null; }],
    ]) {
      const button = dom('button', `icon-button${text === '×' ? ' remove' : ''}`, text);
      button.type = 'button'; button.disabled = state.planBusy || disabled; button.title = label; button.setAttribute('aria-label', label);
      button.addEventListener('click', () => updateGeometry(action));
      controls.append(button);
    }
    toolbar.append(controls);
  }
  body.append(toolbar, dom('span', 'stop-source', `${state.mode === 'demo' ? '示例地点' : '百度地点'} · 主题配图`));
  card.append(body);
  return card;
}

function renderStops() {
  const list = $('stop-list');
  list.replaceChildren();
  state.stops.forEach((stop, index) => {
    list.append(makeStopCard(stop, index));
    const leg = state.route?.segments?.[index];
    if (leg) {
      const caption = dom('li', 'leg-caption', `下一站步行 ${distanceText(leg.distanceM)} · 约 ${minutes(leg.durationSec)} 分钟`);
      list.append(caption);
    }
  });
  $('empty-state').hidden = state.stops.length > 0 || state.readonly;
  $('stop-count').textContent = state.readonly ? `${state.stops.length} 站 · 只读` : `${state.stops.length} / ${maxStops()} 站`;
  $('clear-button').hidden = !state.stops.length || state.readonly;
}

function setSummary(id, value) {
  const content = dom('small', '', '分钟');
  $(id).replaceChildren(document.createTextNode(value === null ? '—' : String(value)), content);
}

function renderSummary() {
  const stayMinutes = state.stops.reduce((sum, stop) => sum + stop.stayMin, 0);
  const walkingSeconds = state.route?.walkingDurationSec;
  const totalSeconds = state.route ? walkingSeconds + stayMinutes * 60 : null;
  setSummary('stay-summary', stayMinutes);
  setSummary('walking-summary', state.route ? minutes(walkingSeconds) : null);
  setSummary('total-summary', totalSeconds === null ? null : minutes(totalSeconds));
  const over = totalSeconds !== null && totalSeconds > state.budgetMin * 60;
  $('budget-message').classList.toggle('over', over);
  $('time-progress-fill').parentElement.classList.toggle('over', over);
  $('time-progress-fill').style.width = totalSeconds === null ? '0%' : `${Math.min(totalSeconds / (state.budgetMin * 60) * 100, 100)}%`;
  $('budget-message').textContent = state.route
    ? over ? `超出预算 ${minutes(totalSeconds - state.budgetMin * 60)} 分钟，可减少一站或缩短停留。` : `全程 ${distanceText(state.route.distanceM)} · 预算还剩 ${Math.floor((state.budgetMin * 60 - totalSeconds) / 60)} 分钟，慢慢走。`
    : state.routeBusy ? '正在获取每一段步行路线，清单仍可修改。' : state.stops.length >= 2 ? '顺序已整理好，生成路线看看是否顺路。' : '加入至少两个地点，就能计算步行路线。';
  $('route-button').disabled = state.readonly || state.configFailed || state.routeBusy || state.planBusy || state.stops.length < 2;
  $('route-button').textContent = state.routeBusy ? '正在算路…' : state.route ? '重新计算路线 ↗' : '生成步行路线 ↗';
  $('share-button').disabled = state.readonly || !state.route || state.routeBusy || state.planBusy;
  $('map-caption-text').textContent = state.route ? `${state.stops.length} 站 · ${distanceText(state.route.distanceM)} · 步行约 ${minutes(walkingSeconds)} 分钟${state.mode === 'demo' ? '（演示）' : ''}` : state.stops.length ? '顺序已标在地图上 · 生成路线后显示步行路径' : '先加几个想去的地方，再连成路线。';
  $('route-source').textContent = state.mode === 'demo' ? '演示数据与路线示意，不用于实际导航。停留时间由你安排。' : state.route ? `${modeName(state.mode)} 步行估算 · 停留时间由你安排。` : '步行时间为地图服务估算，停留时间由你安排。';
  $('budget-readonly').textContent = `${state.budgetMin} 分钟`;
  $('location-note').hidden = true;
}

function render() {
  $('page-heading').closest('.planner').classList.toggle('has-stops', state.stops.length > 0 && !state.readonly);
  $('city-input').value = state.city;
  $('budget-input').value = state.budgetMin;
  $('map-city').replaceChildren(document.createTextNode(state.city), dom('span', '', ' / CITY WALK'));
  $('data-mode').value = state.mode;
  $('summary-panel').hidden = !state.readonly && (state.workspaceTab !== 'route' || !state.stops.length);
  $('nav-stop-count').textContent = state.stops.length;
  $('nav-stop-count').hidden = !state.stops.length;
  $('source-badge').textContent = state.configFailed ? '配置读取失败' : state.mode === 'demo' ? '示例数据 · 非真实道路' : `${modeName(state.mode)} · ${state.route || state.serviceStatus[state.mode]?.search ? '真实数据' : state.stops.length ? '本机草稿' : '等待查询'}`;
  $('source-badge').classList.toggle('demo', state.mode === 'demo' && !state.configFailed);
  renderResults();
  renderStops();
  renderSummary();
  renderConnectionStatus();
  $('example-button').hidden = state.mode !== 'demo';
  $('planning-details').hidden = state.readonly || !state.route?.planning;
  $('planning-summary').textContent = state.route?.planning?.selectionExplanation || '';
  $('planning-warnings').textContent = state.routeMeta?.warnings?.map(warning => typeof warning === 'string' ? warning : warning.message || '').filter(Boolean).join('；') || '';
  $('plan-button').disabled = state.mode !== 'agentplan' || state.planBusy || state.routeBusy || state.configFailed;
  $('plan-button').textContent = state.planBusy ? '⋯' : '↗';
  $('plan-button').setAttribute('aria-label', state.planBusy ? '正在寻找地点并规划路线' : '生成散步路线');
  $('plan-form').setAttribute('aria-busy', String(state.planBusy));
  $('plan-input').disabled = state.planBusy || state.mode !== 'agentplan';
  $('plan-support').textContent = state.mode === 'agentplan' ? '说一句想法，地点和步行路线一起安排。' : '当前模式请在“我的路线”中搜索地点，手动安排散步。';
  $('clear-button').disabled = state.planBusy;
  $('city-input').disabled = state.planBusy;
  $('budget-input').disabled = state.planBusy;
  $('search-button').disabled = state.planBusy || state.searchBusy || state.configFailed;
  $('data-mode').disabled = state.readonly || state.planBusy;
  for (const button of document.querySelectorAll('[data-plan-prompt]')) button.disabled = state.mode !== 'agentplan' || state.planBusy || state.routeBusy || state.configFailed;
  mapView.update(state.stops, state.route, state.selectedId);
  renderOfficialMap();
}

async function initializeMap() {
  const generation = ++state.mapGeneration;
  state.mapLoaded = false;
  unbindZoom?.();
  unbindZoom = undefined;
  $('zoom-controls').hidden = true;
  $('map-error').hidden = true;
  $('fit-map').disabled = true;
  try {
    await mapView.initialize(state.mode, state.config?.browserAk);
    if (generation !== state.mapGeneration) return;
    $('fit-map').disabled = false;
    state.mapLoaded = Boolean(mapView.map);
    renderConnectionStatus();
    if (state.mode !== 'demo' && mapView.map) {
      $('zoom-controls').hidden = false;
      unbindZoom = bindMapusZoomControls(mapView.map);
    }
    mapView.fit();
    renderOfficialMap();
  } catch (error) {
    if (generation !== state.mapGeneration) return;
    if (state.mode === 'agentplan') renderOfficialMap();
    else showMapMessage('地图暂时无法展示', error.message, true);
    renderConnectionStatus();
  }
}

async function bootstrapMap(force = false) {
  if (state.readonly || state.mode !== 'agentplan' || state.config?.browserAk || state.planBusy || state.route || state.bootstrapBusy || (state.bootstrapAttempted && !force)) return;
  state.bootstrapAttempted = true;
  state.bootstrapBusy = true;
  state.bootstrapError = '';
  const city = state.city;
  const searchRequest = state.searchRequest;
  const planRequest = state.planRequest;
  const revision = state.revision;
  renderOfficialMap();
  try {
    const keyword = state.stops[0]?.name || (city === '北京' ? '雍和宫、国子监和五道营胡同' : `${city}历史街区`);
    const response = await api('/api/v1/geo/places/search', { keyword: `在${city}地图上展示${keyword}的位置`, city, mode: 'agentplan' });
    if (state.mode !== 'agentplan' || state.city !== city || state.searchRequest !== searchRequest || state.planRequest !== planRequest || state.revision !== revision || state.route) return;
    const places = response.data?.places;
    const mapUrl = trustedMapUrl(response.data?.mapUrl || response.data?.renderUrl || response.meta?.mapUrl);
    if (!mapUrl || !Array.isArray(places) || dataModeFor(response.meta, places) !== 'agentplan' || places.some(place => !placeMatchesMode(place))) throw new Error('地点查询暂时没有返回可展示的地图，请重新加载。');
    // Opening an exploration map must never create or replace a user's stops.
    state.searchMapUrl = mapUrl;
    state.officialKind = 'search';
    state.officialViewIndex = 0;
    state.serviceStatus.agentplan = { ...state.serviceStatus.agentplan, search: true };
  } catch (error) {
    if (state.searchRequest === searchRequest && state.planRequest === planRequest && state.city === city) state.bootstrapError = error.message;
  } finally {
    state.bootstrapBusy = false;
    const superseded = state.city !== city || state.searchRequest !== searchRequest || state.planRequest !== planRequest || state.revision !== revision;
    if (superseded) state.bootstrapAttempted = false;
    renderOfficialMap();
    renderConnectionStatus();
    if (superseded && !state.route && !state.searchMapUrl && !state.planBusy && !state.searchBusy) bootstrapMap();
  }
}

function changeCity() {
  const next = $('city-input').value.trim();
  if (!next) { $('city-input').value = state.city; notice('请先填写城市名称。'); return false; }
  if (next === state.city) return true;
  if (state.stops.length && !window.confirm(`切换到${next}会清空当前行程。要继续吗？`)) { $('city-input').value = state.city; return false; }
  state.city = next;
  state.stops = [];
  state.results = [];
  state.searchMapUrl = null;
  state.selectedId = null;
  state.searchRequest++;
  state.searchBusy = false;
  $('search-button').disabled = false;
  $('example-button').disabled = false;
  invalidateRoute();
  saveDraft();
  render();
  return true;
}

async function searchPlaces(keyword, example = false) {
  if (state.readonly || state.planBusy || state.configFailed || !changeCity()) return;
  const trimmed = keyword.trim();
  if (!trimmed) { notice('输入一个地点名称，再点击搜索。'); return; }
  const request = ++state.searchRequest;
  const city = state.city;
  const mode = state.mode;
  state.searchBusy = true;
  $('search-button').disabled = true;
  $('example-button').disabled = true;
  notice(example ? '正在寻找三站示例…' : '正在搜索地点…');
  try {
    const response = await api('/api/v1/geo/places/search', { keyword: trimmed, city, mode });
    if (request !== state.searchRequest || city !== state.city || mode !== state.mode) return;
    const places = response.data?.places;
    if (!Array.isArray(places)) throw new Error('地点服务未返回有效的搜索结果。');
    if (dataModeFor(response.meta, places) !== mode || places.some(place => !placeMatchesMode(place, mode))) throw new Error('地点服务返回了坐标系或来源不一致的数据，已停止加载，请重试。');
    state.results = places.map(normalizePlace);
    state.searchMapUrl = trustedMapUrl(response.data.mapUrl || response.data.renderUrl || response.meta?.mapUrl || response.meta?.renderUrl);
    state.officialKind = 'search';
    state.officialViewIndex = 0;
    state.serviceStatus[mode] = { ...state.serviceStatus[mode], search: true };
    saveDraft();
    renderConnectionStatus();
    if (example) {
      if (!state.results.length) { notice('当前数据源没有返回示例地点，可以直接搜索想去的地点。'); renderResults(); return; }
      if (state.stops.length && !window.confirm('用搜索返回的前三个地点替换当前清单吗？')) { renderResults(); notice('示例地点已列出，可以按需加入。', true); return; }
      state.stops = state.results.slice(0, Math.min(3, maxStops())).map(place => ({ ...place, stayMin: 20 }));
      state.selectedId = state.stops[0]?.placeId || null;
      state.results = [];
      invalidateRoute();
      saveDraft();
      render();
      mapView.fit();
      notice(`已放入 ${state.stops.length} 站${mode === 'demo' ? '演示' : ''}地点，点击生成步行路线。`, true);
    } else {
      render();
      notice(state.results.length ? `找到 ${state.results.length} 个地点，选择想去的地方。` : '没有找到这个地点，试试更具体的店名或地址。', state.results.length > 0);
    }
    showWarnings(response.meta?.warnings);
  } catch (error) {
    if (request === state.searchRequest) { state.results = []; renderResults(); notice(error.message); }
  } finally {
    if (request === state.searchRequest) {
      state.searchBusy = false;
      $('search-button').disabled = false;
      $('example-button').disabled = false;
      if (!state.route && !state.searchMapUrl) bootstrapMap();
    }
  }
}

function showWarnings(warnings) {
  // Fixture provenance remains permanently visible on map, cards and summary.
  // Avoid replacing the useful completion message with the same demo warning.
  if (state.mode === 'demo') return;
  if (!Array.isArray(warnings) || !warnings.length) return;
  const text = warnings.map(warning => typeof warning === 'string' ? warning : warning.message || '').filter(Boolean).join('；');
  if (text) notice(text);
}

function validRoute(route, expected) {
  if (!route || typeof route.routeResultId !== 'string' || typeof route.inputHash !== 'string' || !Array.isArray(route.orderedStops) || !Array.isArray(route.segments) || route.segments.length !== expected.length - 1 || !Number.isFinite(route.distanceM) || route.distanceM < 0 || !Number.isFinite(route.walkingDurationSec) || route.walkingDurationSec < 0) return false;
  const coordSystem = coordinateSystemForMode(state.mode);
  if (route.coordSystem && normalizeCoordSystem(route.coordSystem) !== coordSystem) return false;
  if (route.orderedStops.length !== expected.length || route.orderedStops.some((stop, index) => !placeMatchesMode(stop) || stop.placeId !== expected[index].placeId || stop.location.lng !== expected[index].location.lng || stop.location.lat !== expected[index].location.lat)) return false;
  return route.segments.every((segment, index) => {
    if (segment.fromId !== expected[index].placeId || segment.toId !== expected[index + 1].placeId || (segment.coordSystem && normalizeCoordSystem(segment.coordSystem) !== coordSystem) || !Number.isFinite(segment.distanceM) || segment.distanceM < 0 || !Number.isFinite(segment.durationSec) || segment.durationSec < 0 || !Array.isArray(segment.path)) return false;
    if (segment.path.length === 0) return state.mode === 'agentplan' && route.geometryUnavailable === true && segment.geometryUnavailable === true && Boolean(trustedMapUrl(segment.mapUrl || segment.renderUrl || route.mapUrls?.[index] || (route.segments.length === 1 ? route.mapUrl || route.renderUrl : null)));
    return segment.path.length >= 2 && segment.path.every(point => Number.isFinite(point.lng) && Number.isFinite(point.lat) && point.lng >= -180 && point.lng <= 180 && point.lat >= -90 && point.lat <= 90 && normalizeCoordSystem(point.coordSystem || segment.coordSystem || route.coordSystem || coordSystem) === coordSystem);
  });
}

async function planWalk(rawRequest) {
  if (state.readonly || state.planBusy || state.routeBusy || state.configFailed || !state.config) return;
  if (state.mode !== 'agentplan') { showWorkspaceTab('route'); notice('当前模式支持搜索加点，切换到百度地图 AgentPlan 后可以一句话规划。'); return; }
  const requestText = rawRequest.trim();
  if (!requestText) { notice('说说想在哪儿走、留多少时间，以及想去什么地方。'); $('plan-input').focus(); return; }
  if (requestText.length > 1000) { notice('需求请控制在 1000 字以内。'); return; }
  const request = ++state.planRequest;
  const revision = state.revision;
  const mode = state.mode;
  state.searchRequest++;
  state.searchBusy = false;
  state.planBusy = true;
  renderSummary();
  render();
  notice('正在寻找真实地点，并计算相邻地点之间的步行道路…');
  try {
    const response = await api('/api/v1/itineraries/plan', { request: requestText, city: state.city, mode });
    if (request !== state.planRequest || revision !== state.revision || mode !== state.mode) {
      notice('规划期间清单已修改，原来的修改已保留。可以按新需求重新规划。');
      return;
    }
    const route = response.data;
    const places = route?.orderedStops;
    if (!Array.isArray(places) || places.length < 2 || places.length > maxStops() || dataModeFor(response.meta, places) !== mode || !validRoute(route, places)) throw new Error('规划服务未返回完整的真实地点和步行路线，请换一个更具体的街区重试。');
    invalidateRoute();
    state.stops = places.map(place => ({ ...normalizePlace(place), stayMin: intValue(place.stayMin ?? route.suggestedStays?.find(stay => stay.placeId === place.placeId)?.stayMin, 20, 0, 240) }));
    state.city = route.city || state.stops[0].city || state.city;
    state.budgetMin = intValue(route.budgetMin, state.budgetMin, 1);
    state.route = route;
    state.routeMeta = response.meta;
    state.results = Array.isArray(route.places) ? route.places.filter(place => placeMatchesMode(place)).map(normalizePlace) : [];
    state.searchMapUrl = trustedMapUrl(route.searchMapUrl);
    state.officialKind = 'route';
    state.selectedId = state.stops[0].placeId;
    state.serviceStatus[mode] = { search: true, route: true };
    showWorkspaceTab('route');
    $('page-heading').textContent = `${state.city}，这一程慢慢走。`;
    $('intro-description').textContent = `${state.stops.length} 个停靠点 · 真实步行路线 · 停留时间随你调整`;
    saveDraft();
    notice(`已安排 ${state.stops.length} 站 · ${distanceText(route.distanceM)}，可以直接分享，停留时间随你调整。`, true);
  } catch (error) {
    if (request === state.planRequest) notice(error.message);
  } finally {
    if (request === state.planRequest) {
      state.planBusy = false; render();
      if (!state.route && !state.searchMapUrl) bootstrapMap();
    }
  }
}

async function calculateRoute() {
  if (state.readonly || state.routeBusy || state.planBusy || state.stops.length < 2 || state.configFailed) return;
  const revision = state.revision;
  const request = ++state.routeRequest;
  const orderedStops = state.stops.map(({ stayMin, ...place }) => place);
  const mode = state.mode;
  state.routeBusy = true;
  state.route = null;
  state.routeMeta = null;
  render();
  notice('正在计算相邻地点之间的步行路线…');
  try {
    // Live AgentPlan verification supports explicit stop-to-stop planning without location.
    // Do not request device permission or replace the user's location with a selected stop.
    const response = await api('/api/v1/geo/routes/walking', { orderedStops, mode, requestId: `cw-${Date.now()}-${request}` });
    if (request !== state.routeRequest || revision !== state.revision || mode !== state.mode) {
      notice('算路时清单发生了变化，已忽略旧路线。按当前顺序重新生成即可。');
      return;
    }
    if (dataModeFor(response.meta, response.data?.orderedStops) !== mode || !validRoute(response.data, orderedStops)) throw new Error('路线结果不完整，或地点、来源、坐标系与当前清单不一致，暂时不能分享。请重试或调整地点。');
    state.route = response.data;
    state.routeMeta = response.meta;
    state.officialKind = 'route';
    state.officialViewIndex = 0;
    state.serviceStatus[mode] = { ...state.serviceStatus[mode], route: true };
    notice(mode === 'demo' ? '演示路线已生成。路径与时间为示例数据，不用于实际导航。' : '步行路线已生成，可以查看时间预算并分享给朋友。', true);
    showWarnings(response.meta?.warnings);
    mapView.fit();
  } catch (error) {
    if (request === state.routeRequest && revision === state.revision) {
      state.route = null;
      notice(error.message);
    }
  } finally {
    if (request === state.routeRequest) { state.routeBusy = false; render(); }
  }
}

function openShare() {
  if (!state.route || state.readonly) return;
  if (state.shareBusy) { notice('分享请求仍在处理中，请稍等片刻。'); return; }
  $('share-title').value = `一起走 · ${state.city} CityWalk`;
  $('share-result').hidden = true;
  $('share-error').hidden = true;
  $('share-form').hidden = false;
  $('create-share').hidden = false;
  $('create-share').disabled = false;
  $('share-title').readOnly = false;
  $('share-dialog').showModal();
}

async function createShare(event) {
  event.preventDefault();
  if (!state.route || state.shareBusy || state.readonly) return;
  const title = $('share-title').value.trim();
  if (!title) { $('share-error').hidden = false; $('share-error').textContent = '给这次散步起个名字吧。'; return; }
  const routeId = state.route.routeResultId;
  const revision = state.revision;
  const stays = state.stops.map(stop => ({ placeId: stop.placeId, stayMin: stop.stayMin }));
  state.shareBusy = true;
  $('create-share').disabled = true;
  $('create-share').textContent = '正在生成链接…';
  $('share-error').hidden = true;
  try {
    const response = await api('/api/v1/shares', { routeResultId: routeId, inputHash: state.route.inputHash, title, stays, budgetMin: state.budgetMin });
    if (revision !== state.revision || state.route?.routeResultId !== routeId || !$('share-dialog').open) return;
    const url = new URL(response.data?.shareUrl, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('服务返回的分享链接格式不正确，请重试。');
    $('share-url').value = url.href;
    $('open-share').href = url.href;
    $('share-expiry').textContent = response.data.expiresAt ? `有效至 ${formatDate(response.data.expiresAt)}。持有链接的人都可以查看。` : '持有链接的人都可以查看这份行程。';
    $('share-result').hidden = false;
    $('create-share').hidden = true;
    $('share-title').readOnly = true;
  } catch (error) {
    $('share-error').hidden = false;
    $('share-error').textContent = error.message;
  } finally {
    state.shareBusy = false;
    $('create-share').disabled = false;
    $('create-share').textContent = '生成行程链接 ↗';
  }
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

async function copyLink(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = '已复制 ✓';
    setTimeout(() => { button.textContent = button.id === 'copy-page-button' ? '复制行程链接' : '复制链接'; }, 2200);
  } catch {
    if (button.id === 'copy-share') { $('share-url').focus(); $('share-url').select(); $('share-error').textContent = '浏览器未允许自动复制，已选中链接，请手动复制。'; $('share-error').hidden = false; }
    else { notice('浏览器未允许自动复制，请复制地址栏中的行程链接。'); }
  }
}

function readonlyShell() {
  $('workspace-navigation').hidden = true;
  showWorkspaceTab('route');
  $('quick-plan-section').hidden = true;
  $('data-mode').disabled = true;
  $('search-section').hidden = true;
  $('edit-actions').hidden = true;
  $('readonly-actions').hidden = false;
  $('budget-editor').hidden = true;
  $('budget-readonly').hidden = false;
  $('draft-status').textContent = '只读行程 · 本页不会改动你浏览器里的草稿';
  $('intro-kicker').textContent = '朋友发来的 · 一场散步';
  $('page-heading').textContent = '正在读取行程…';
  $('intro-description').textContent = '每一站都有顺序，每一次停留都留点时间。';
  $('itinerary-heading').textContent = '这次我们这样走';
  $('empty-state').hidden = true;
}

async function refreshOfficialMap() {
  if (state.officialFrameStatus !== 'expired') { renderOfficialMap(true); return; }
  const current = officialMapViews()[state.officialViewIndex];
  if (!state.readonly) {
    if (current?.kind === 'route' && state.stops.length >= 2) await calculateRoute();
    else await searchPlaces($('keyword-input').value || state.stops[0]?.name || state.city);
    return;
  }
  if (state.routeBusy) return;
  state.routeBusy = true;
  $('retry-official-map').disabled = true;
  notice('正在为分享中的原地点更新地图…');
  try {
    const response = await api('/api/v1/geo/routes/walking', { orderedStops: state.stops.map(({stayMin, ...place}) => place), mode: state.mode });
    if (!validRoute(response.data, state.stops) || dataModeFor(response.meta, state.stops) !== state.mode) throw new Error('未能获取与原行程一致的新地图，请稍后重试。');
    state.route.mapUrl = response.data.mapUrl;
    state.route.mapUrls = response.data.mapUrls;
    state.route.segments.forEach((segment, index) => { segment.mapUrl = response.data.segments[index].mapUrl; });
    notice('地图已更新，地点与时间仍保留分享时的安排。', true);
    renderOfficialMap(true);
  } catch (error) { notice(error.message); }
  finally { state.routeBusy = false; $('retry-official-map').disabled = false; }
}

async function loadShare(token) {
  const response = await api(`/api/v1/shares/${encodeURIComponent(token)}`);
  const shared = response.data;
  if (!shared || !Array.isArray(shared.orderedStops) || !shared.orderedStops.every(validPlace) || !Array.isArray(shared.segments)) throw new Error('这份行程数据不完整，暂时无法展示。');
  state.shareSnapshot = shared;
  state.routeMeta = response.meta;
  state.mode = dataModeFor(response.meta, shared.orderedStops);
  if (shared.orderedStops.some(stop => !placeMatchesMode(stop))) throw new Error('这份行程包含不一致的数据来源或坐标系，已停止展示。');
  state.city = shared.city || '城市散步';
  state.stops = shared.orderedStops.map(stop => ({ ...normalizePlace(stop), stayMin: intValue(stop.stayMin, 20, 0, 240) }));
  state.budgetMin = intValue(shared.budgetMin, 180, 1);
  state.route = { segments: shared.segments, orderedStops: state.stops, distanceM: shared.distanceM, walkingDurationSec: shared.walkingDurationSec, coordSystem: shared.coordSystem, mapUrl: shared.mapUrl, renderUrl: shared.renderUrl, mapUrls: shared.mapUrls, geometryUnavailable: shared.geometryUnavailable };
  state.officialKind = 'route';
  const validationResult = { ...state.route, routeResultId: 'share-view', inputHash: 'share-view' };
  if (!validRoute(validationResult, state.stops)) throw new Error('这份分享的步行路线不完整，暂时无法展示。');
  $('page-heading').textContent = shared.title || '一起走 · CityWalk';
  document.title = `${shared.title || 'CityWalk 行程'} · 一起走`;
  $('intro-description').textContent = `固定行程 · ${state.stops.length} 站${shared.expiresAt ? ` · 有效至 ${formatDate(shared.expiresAt)}` : ''}`;
  render();
  $('route-source').textContent += ' 营业与可进入状态请出发前确认。';
}

function bindEvents() {
  $('discover-tab').addEventListener('click', () => showWorkspaceTab('discover'));
  $('route-tab').addEventListener('click', () => showWorkspaceTab('route'));
  for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
    state.discoveryFilter = button.dataset.filter;
    for (const chip of document.querySelectorAll('[data-filter]')) {
      chip.classList.toggle('active', chip === button);
      chip.setAttribute('aria-pressed', String(chip === button));
    }
    renderDiscovery();
  });
  renderDiscovery();
  $('plan-form').addEventListener('submit', event => { event.preventDefault(); planWalk($('plan-input').value); });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); searchPlaces($('keyword-input').value); });
  $('city-input').addEventListener('change', changeCity);
  $('example-button').addEventListener('click', () => searchPlaces('示例', true));
  $('clear-button').addEventListener('click', () => { if (window.confirm('清空当前清单，重新规划吗？')) updateGeometry(() => { state.stops = []; state.selectedId = null; }); });
  $('budget-input').addEventListener('change', () => {
    const next = intValue($('budget-input').value, -1, 1);
    if (next < 0) { $('budget-input').value = state.budgetMin; notice('时间预算请输入 1–1440 的整数分钟。'); return; }
    state.budgetMin = next; saveDraft(); renderSummary();
  });
  $('route-button').addEventListener('click', calculateRoute);
  $('share-button').addEventListener('click', openShare);
  $('share-form').addEventListener('submit', createShare);
  $('close-share').addEventListener('click', () => $('share-dialog').close());
  $('share-dialog').addEventListener('close', () => { $('create-share').hidden = false; $('share-title').readOnly = false; });
  $('copy-share').addEventListener('click', () => copyLink($('share-url').value, $('copy-share')));
  $('copy-page-button').addEventListener('click', () => copyLink(window.location.href, $('copy-page-button')));
  $('fit-map').addEventListener('click', () => mapView.fit());
  $('retry-map').addEventListener('click', () => state.mode === 'agentplan' && !state.config?.browserAk ? bootstrapMap(true) : initializeMap());
  $('retry-official-map').addEventListener('click', refreshOfficialMap);
  $('official-map-view').addEventListener('change', () => { state.officialViewIndex = Number($('official-map-view').value) || 0; renderOfficialMap(); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.hostedMap && state.officialFrameStatus !== 'expired') renderOfficialMap(true); }, 250);
  });
  $('data-mode').addEventListener('change', () => {
    const next = $('data-mode').value;
    if (next === state.mode || state.readonly) return;
    if (!['demo', 'baidu', 'agentplan'].includes(next) || (next !== 'demo' && !state.config.capabilities?.[next])) { $('data-mode').value = state.mode; notice('这个数据来源尚未配置，暂时不能使用。'); return; }
    if (state.stops.length && !window.confirm('切换数据来源会清空当前行程，避免混用示例与真实地点。要继续吗？')) { $('data-mode').value = state.mode; return; }
    state.mode = next; state.stops = []; state.results = []; state.selectedId = null; state.searchMapUrl = null;
    state.bootstrapAttempted = false; state.bootstrapError = '';
    state.searchRequest++; state.searchBusy = false;
    $('search-button').disabled = false; $('example-button').disabled = false;
    invalidateRoute(); saveDraft();
    if (mapView.requiresReload(next)) { notice('坐标系不同，正在重新加载对应地图…'); window.location.reload(); return; }
    render(); initializeMap();
    if (next === 'agentplan') bootstrapMap();
    notice(next === 'demo' ? '示例模式使用固定演示数据，不代表真实地图或道路。' : `已选择${modeName(next)}，搜索时验证服务连接。`, true);
  });
}

async function initialize() {
  bindEvents();
  if (state.readonly) readonlyShell();
  try {
    state.config = await api('/api/config');
    if (!['demo', 'baidu', 'agentplan'].includes(state.config.mode)) throw new Error('当前数据模式不可用于地点检索，请由开发者选择 demo、baidu 或 agentplan。');
    state.mode = state.config.mode;
    renderConnectionStatus();
    if (state.readonly) await loadShare(shareMatch[1]);
    else {
      loadDraft();
      const baiduOption = $('data-mode').querySelector('[value="baidu"]');
      baiduOption.disabled = !state.config.capabilities?.baidu;
      baiduOption.title = state.config.capabilities?.baidu ? '' : '需要开发者配置百度服务端 AK';
      const agentplanOption = $('data-mode').querySelector('[value="agentplan"]');
      agentplanOption.disabled = !state.config.capabilities?.agentplan;
      agentplanOption.title = state.config.capabilities?.agentplan ? '' : '需要开发者配置 AgentPlan SK';
      $('data-mode').disabled = false;
      render();
    }
    if (!state.hostedMap) await initializeMap();
    if (!state.readonly) bootstrapMap();
  } catch (error) {
    state.configFailed = true;
    if (state.readonly) { $('page-heading').textContent = '这份行程暂时无法打开'; $('intro-description').textContent = '链接可能已失效，或服务暂时不可用。'; $('readonly-actions').hidden = true; }
    notice(error.message);
    $('map-error').hidden = false;
    $('map-error-text').textContent = '未能读取可用的地图或行程配置，请稍后刷新重试。';
    $('retry-map').hidden = true;
    $('search-button').disabled = true;
    $('plan-button').disabled = true;
    $('example-button').disabled = true;
    $('route-button').disabled = true;
    $('share-button').disabled = true;
    $('source-badge').textContent = '服务暂时不可用';
    $('connection-label').textContent = '地图连接失败';
    for (const button of document.querySelectorAll('[data-plan-prompt]')) button.disabled = true;
  }
}

initialize();
