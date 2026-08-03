const SWEEP_LIMIT = 50;

const SWEEP_GUIDE = Object.freeze({
  host: { label: 'Host / 통합 메모리 용량', unit: 'GB', description: '물리 Host RAM 또는 통합 메모리 시스템의 공유 메모리 풀입니다.', relationship: '조건부: 메모리 압력 임계값을 바꾸며, 자동 배치에서는 계산된 DRAM Expert 캐시 예산도 바꿉니다.' },
  dramBW: { label: 'DRAM 대역폭', unit: 'GB/s', description: '데이터가 메모리에 상주한 뒤 사용하는 Host 또는 통합 DRAM 경로의 대역폭입니다.', relationship: '독립 자원 한계이지만 DRAM 경로로 모델링된 트래픽에만 영향을 줍니다.' },
  ssdBW: { label: '유효 SSD / NAND 대역폭', unit: 'GB/s', description: '스토리지가 Expert, 윈도, 프리페치, 스왑 읽기·쓰기를 처리하는 속도입니다.', relationship: '독립 스토리지 단계 한계입니다. 큐 깊이, 지연시간, 워크로드 또는 PCIe가 전체 시간을 계속 지배할 수 있습니다.' },
  pcieBW: { label: 'PCIe Host ↔ GPU 대역폭', unit: 'GB/s', description: 'Host 메모리와 개별 GPU 사이의 전송 링크 대역폭이며 SSD 미디어 읽기 속도와 다릅니다.', relationship: '조건부: 개별 GPU 전송에서 사용하며 통합 메모리 구조에서는 사용하지 않습니다.' },
  vram: { label: 'GPU VRAM 용량', unit: 'GB', description: '개별 GPU의 물리 메모리 용량입니다.', relationship: '조건부: 자동 배치에서는 KV와 작업 공간을 예약한 뒤 계산되는 VRAM Expert 캐시를 바꿉니다.' },
  arch: { label: '메모리 구조', unit: '범주', description: '개별 GPU와 통합 메모리 데이터 경로 중 하나를 선택합니다.', relationship: '연동 스위치: PCIe와 VRAM 매개변수를 사용할지 결정합니다.' },
  placement: { label: 'Expert 캐시 배치', unit: '범주', description: '용량에서 자동 계산한 캐시 또는 명시적인 수동 캐시 예산을 선택합니다.', relationship: '연동 스위치: 자동은 dcache/vcache를 계산하고 수동은 입력값을 그대로 사용합니다.' },
  experts: { label: '레이어당 Expert 수', unit: 'Expert', description: '각 MoE 레이어의 전체 라우팅 Expert 수입니다.', relationship: '연동 제약: 활성 Expert 수는 전체 Expert 수를 초과할 수 없습니다.' },
  active: { label: '토큰당 활성 Expert 수', unit: 'Expert/토큰', description: '각 토큰에서 선택되는 Expert 수 또는 AFM 활성 집합 크기입니다.', relationship: '연동 제약: 전체 Expert 수 이하여야 하며 AFM은 shared/routed/active 차원도 함께 정규화합니다.' },
  shared: { label: '공유 활성 Expert 수', unit: 'Expert/토큰', description: 'AFM 선택 사이에서 공유되는 활성 Expert 수입니다.', relationship: '연동 제약: active를 초과할 수 없으며 값을 바꾸면 routed Expert 수도 갱신됩니다.' },
  expertWidth: { label: 'Expert 채널 너비', unit: '채널', description: '각 활성 Expert가 제공하는 AFM 채널 너비입니다.', relationship: '연동: 보통 이 값을 바꾸면 활성 FFN 차원도 갱신됩니다.' },
  activeDim: { label: '활성 FFN 차원', unit: '채널', description: '명시적으로 지정하는 전체 활성 Feed-Forward 차원입니다.', relationship: '직접 스윕하지 않으면 기본적으로 active × Expert 너비에서 계산됩니다.' },
  'mem.soft': { label: '소프트 압력 시작점', unit: '비율(0–1)', description: '메모리 회수 압력이 시작되는 물리 메모리 사용률입니다.', relationship: '순서 임계값: soft ≤ compression ≤ swap ≤ hard를 유지해야 합니다.' },
  'mem.compress': { label: '압축 시작점', unit: '비율(0–1)', description: '메모리 압축이 시작되는 사용률입니다.', relationship: '순서 임계값을 유지해야 하며 메모리 압축이 활성화되어야 합니다.' },
  'mem.swap': { label: '스왑 시작점', unit: '비율(0–1)', description: '스왑 허용이 시작되는 사용률입니다.', relationship: '순서 임계값을 유지해야 하며 호환 메모리 정책과 스왑이 활성화되어야 합니다.' },
  'mem.hard': { label: '하드 압력 한계', unit: '비율(0–1)', description: '할당이 대기하거나 실패하기 전 허용되는 최대 물리 메모리 사용률입니다.', relationship: '순서 임계값: soft ≤ compression ≤ swap ≤ hard를 유지해야 합니다.' },
  'mem.compressionEnabled': { label: '메모리 압축 사용', unit: '불리언', description: '모델링된 메모리 압축 경로를 활성화합니다.', relationship: '압축률과 압축 대역폭이 결과에 영향을 줄 수 있는지 결정합니다.' },
  'mem.swapEnabled': { label: '스왑 사용', unit: '불리언', description: '모델링된 스왑 용량과 I/O를 활성화합니다.', relationship: '호환 메모리 정책이 필요하며 스왑 용량, 쓰기 비율, 재접근 비율의 적용 여부를 결정합니다.' },
  pf: { label: '프리페치 사용', unit: '불리언', description: '요청 전에 Expert 프리페치를 실행합니다.', relationship: '프리페치 정책, 재현율, 정밀도, 예산이 실행에 영향을 주는지 결정합니다.' },
  prefetchPolicy: { label: '프리페치 정책', unit: '범주', description: '후보 Expert를 예측하는 방식을 선택합니다.', relationship: '조건부: 프리페치가 활성화되어야 하며 none은 예측 효과를 끕니다.' },
  qd: { label: '스토리지 큐 깊이 / 워커 수', unit: '요청', description: '동시에 서비스를 처리할 수 있는 모델링된 최대 스토리지 슬롯 수입니다.', relationship: 'SSD 대역폭과 기본 지연시간에 함께 작용하지만 워커가 늘어도 설정된 SSD 대역폭 상한은 커지지 않습니다.' }
});

const SWEEP_UNITS = Object.freeze({
  prompt: '토큰', output: '토큰', context: '토큰', conc: '시퀀스', seed: '정수', lat: 'µs', layers: '레이어', esize: 'MB/Expert', resident: 'GB', kvKB: 'KB/토큰', dcache: 'GB', minDCache: 'GB', vcache: 'GB', pinned: 'GB', page: 'GB', corr: '비율(0–1)', attn: 'ms/토큰', ems: 'ms/Expert', par: 'Expert', prefillSpeedup: '×', recall: '비율(0–1)', precision: '비율(0–1)', budget: 'MB/레이어', totalB: '10억 매개변수', hidden: '채널', projections: '투영', chunks: '청크', bits: 'bit/가중치', packing: '×', commonGB: 'GB', freq: '토큰', overlap: '비율(0–1)', initSel: 'ms', periodicSel: 'ms', patchBase: 'ms', patchBW: 'GB/s', ffn: 'ms/토큰', runtime: 'ms/토큰', prefillTPS: '토큰/s', 'mem.backgroundGB': 'GB', 'mem.osReservedGB': 'GB', 'mem.minHeadroomGB': 'GB', 'mem.compressionRatio': '×', 'mem.compressionBW': 'GB/s', 'mem.swapCapacityGB': 'GB', 'mem.swapWriteRatio': '비율', 'mem.kvTouchFraction': '비율(0–1)'
});

function sweepHumanLabel(path) {
  return path.replace(/^mem\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('.', ' / ').replace(/^./, value => value.toUpperCase());
}

function sweepParameterGuide(descriptor, config = {}) {
  const explicit = SWEEP_GUIDE[descriptor.path] || {};
  const typeUnit = descriptor.type === 'boolean' ? '불리언' : descriptor.type === 'enum' ? '범주' : '단위 없음';
  const categoryMeaning = {
    Workload: '합성 요청 집합을 정의하며 하드웨어 용량이 아니라 수요를 바꿉니다.',
    Memory: '메모리 용량, 상주 상태, 압력, 압축 또는 스왑 동작을 제어합니다.',
    Model: '모델 토폴로지 또는 보정된 모델 메모리 크기를 제어합니다.',
    Compute: '보정된 연산 또는 런타임 단계를 제어합니다.',
    Prefetch: '예측 기반 Expert 로딩과 정확도 또는 예산을 제어합니다.',
    'System / Storage': '하드웨어 용량, 전송 단계 또는 스토리지 서비스 한계를 제어합니다.'
  }[descriptor.category] || '시뮬레이터 입력 하나를 제어합니다.';
  return {
    path: descriptor.path,
    label: explicit.label || sweepHumanLabel(descriptor.path),
    unit: explicit.unit || SWEEP_UNITS[descriptor.path] || typeUnit,
    description: explicit.description || categoryMeaning,
    relationship: explicit.relationship || 'OAT는 이 설정값만 바꾸지만 유효성 및 후속 병목은 다른 입력에도 의존할 수 있습니다.',
    behavior: explicit.behavior || '이 자원 또는 동작이 현재 활성 임계 경로에서 사용될 때만 지표가 변합니다. 변화가 없는 평탄한 스윕도 정상적인 포화 결과일 수 있습니다.'
  };
}

function sweepDescriptor(path, category, min, max, options = {}) {
  return Object.freeze({ path, category, min, max, type: options.type || 'number', integer: Boolean(options.integer), values: options.values || null, label: options.label || path });
}

const SWEEP_COMMON = Object.freeze([
  sweepDescriptor('prompt', 'Workload', 0, 1_000_000, { integer: true }), sweepDescriptor('output', 'Workload', 1, 1024, { integer: true }), sweepDescriptor('context', 'Workload', 1, 10_000_000, { integer: true }), sweepDescriptor('conc', 'Workload', 1, 64, { integer: true }), sweepDescriptor('seed', 'Workload', 0, Number.MAX_SAFE_INTEGER, { integer: true }),
  sweepDescriptor('host', 'System / Storage', 0.001, 4096), sweepDescriptor('dramBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('ssdBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('lat', 'System / Storage', 0, 10_000_000),
  sweepDescriptor('mem.policy', 'Memory', 0, 0, { type: 'enum', values: ['strict', 'reclaim', 'swap'] }), sweepDescriptor('mem.backgroundGB', 'Memory', 0, 4096), sweepDescriptor('mem.osReservedGB', 'Memory', 0, 4096), sweepDescriptor('mem.minHeadroomGB', 'Memory', 0, 4096),
  sweepDescriptor('mem.soft', 'Memory', 0.01, 1), sweepDescriptor('mem.compress', 'Memory', 0.01, 1), sweepDescriptor('mem.swap', 'Memory', 0.01, 1), sweepDescriptor('mem.hard', 'Memory', 0.01, 1),
  sweepDescriptor('mem.compressionEnabled', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('mem.compressionRatio', 'Memory', 1, 100), sweepDescriptor('mem.compressionBW', 'Memory', 0.001, 100_000), sweepDescriptor('mem.swapEnabled', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('mem.swapCapacityGB', 'Memory', 0, 16_384), sweepDescriptor('mem.swapWriteRatio', 'Memory', 0.001, 1), sweepDescriptor('mem.kvTouchFraction', 'Memory', 0, 1)
]);

const SWEEP_COLIBRI = Object.freeze([
  sweepDescriptor('arch', 'System / Storage', 0, 0, { type: 'enum', values: ['unified', 'discrete'] }), sweepDescriptor('vram', 'System / Storage', 0, 1024), sweepDescriptor('pcieBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('qd', 'System / Storage', 1, 4096, { integer: true }),
  sweepDescriptor('cold', 'Model', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('placement', 'Model', 0, 0, { type: 'enum', values: ['auto', 'manual'] }), sweepDescriptor('layers', 'Model', 1, 500, { integer: true }), sweepDescriptor('experts', 'Model', 1, 4096, { integer: true }), sweepDescriptor('active', 'Model', 1, 4096, { integer: true }), sweepDescriptor('esize', 'Model', 0.001, 1_000_000), sweepDescriptor('resident', 'Model', 0, 4096), sweepDescriptor('kvKB', 'Model', 0, 1_000_000),
  sweepDescriptor('dcache', 'Memory', 0, 4096), sweepDescriptor('minDCache', 'Memory', 0, 4096), sweepDescriptor('vcache', 'Memory', 0, 1024), sweepDescriptor('pinned', 'Memory', 0, 4096), sweepDescriptor('page', 'Memory', 0, 4096), sweepDescriptor('expertBacking', 'Memory', 0, 0, { type: 'enum', values: ['file', 'anonymous'] }), sweepDescriptor('odirect', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }),
  sweepDescriptor('corr', 'Compute', 0, 1), sweepDescriptor('attn', 'Compute', 0, 1_000_000), sweepDescriptor('ems', 'Compute', 0, 1_000_000), sweepDescriptor('par', 'Compute', 1, 4096, { integer: true }), sweepDescriptor('prefillSpeedup', 'Compute', 0.001, 1_000_000),
  sweepDescriptor('pf', 'Prefetch', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('prefetchPolicy', 'Prefetch', 0, 0, { type: 'enum', values: ['none', 'previous-token', 'popularity'] }), sweepDescriptor('recall', 'Prefetch', 0, 1), sweepDescriptor('precision', 'Prefetch', 0.001, 1), sweepDescriptor('budget', 'Prefetch', 0, 1_000_000)
]);

const SWEEP_AFM = Object.freeze([
  sweepDescriptor('totalB', 'Model', 0.001, 1_000_000), sweepDescriptor('layers', 'Model', 1, 500, { integer: true }), sweepDescriptor('hidden', 'Model', 1, 1_000_000, { integer: true }), sweepDescriptor('active', 'Model', 1, 4096, { integer: true }), sweepDescriptor('shared', 'Model', 0, 4096, { integer: true }), sweepDescriptor('expertWidth', 'Model', 1, 1_000_000, { integer: true }), sweepDescriptor('activeDim', 'Model', 1, 100_000_000, { integer: true }), sweepDescriptor('projections', 'Model', 1, 16, { integer: true }), sweepDescriptor('chunks', 'Model', 1, 128, { integer: true }), sweepDescriptor('bits', 'Model', 1, 16), sweepDescriptor('packing', 'Model', 1, 10), sweepDescriptor('commonGB', 'Model', 0, 4096),
  sweepDescriptor('freq', 'Compute', 1, 1_000_000, { integer: true }), sweepDescriptor('overlap', 'Compute', 0, 1), sweepDescriptor('initSel', 'Compute', 0, 1_000_000), sweepDescriptor('periodicSel', 'Compute', 0, 1_000_000), sweepDescriptor('patchBase', 'Compute', 0, 1_000_000), sweepDescriptor('patchBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('attn', 'Compute', 0, 1_000_000), sweepDescriptor('ffn', 'Compute', 0, 1_000_000), sweepDescriptor('runtime', 'Compute', 0, 1_000_000), sweepDescriptor('prefillTPS', 'Compute', 0.001, 1_000_000), sweepDescriptor('chunkMode', 'Compute', 0, 0, { type: 'enum', values: ['sequential', 'pipelined'] }), sweepDescriptor('doubleBuffer', 'Compute', 0, 0, { type: 'boolean', values: [false, true] })
]);

function sweepCatalogForConfig(config) {
  if (!config || !['colibri', 'afm3'].includes(config.mode)) return [];
  const catalog = [...SWEEP_COMMON, ...(config.mode === 'afm3' ? SWEEP_AFM : SWEEP_COLIBRI)];
  if (config.mode === 'afm3') return catalog;
  return catalog.filter(descriptor => {
    if (config.arch === 'unified' && ['vram', 'pcieBW'].includes(descriptor.path)) return false;
    if (config.placement === 'auto' && ['dcache', 'vcache'].includes(descriptor.path)) return false;
    if (config.placement === 'manual' && descriptor.path === 'minDCache') return false;
    return true;
  });
}

function sweepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sweepValueAtPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setSweepPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
  return object;
}

function normalizeSweepRelations(config, changedPaths) {
  if (config.mode !== 'afm3') return config;
  const paths = new Set(changedPaths);
  const activeOnly = paths.has('active') && !paths.has('shared');
  const sharedOnly = paths.has('shared') && !paths.has('active');
  if (activeOnly && config.shared > config.active) config.shared = config.active;
  if (sharedOnly && config.active < config.shared) config.active = config.shared;
  if (paths.has('active') || paths.has('shared')) config.routed = config.active - config.shared;
  if ((paths.has('active') || paths.has('shared') || paths.has('expertWidth')) && !paths.has('activeDim')) config.activeDim = config.active * config.expertWidth;
  return config;
}

function autoSweepValues(descriptor, baselineValue) {
  if (descriptor.type !== 'number' || !Number.isFinite(baselineValue)) return [...(descriptor.values || [])];
  const values = [0.5, 0.75, 1, 1.5, 2].map(ratio => clamp(baselineValue * ratio, descriptor.min, descriptor.max)).map(value => descriptor.integer ? Math.round(value) : Number(value.toPrecision(12)));
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCustomSweepValues(descriptor, text) {
  const parts = String(text).split(',').map(value => value.trim());
  const values = parts.map(Number);
  if (!parts.length || parts.some(value => value === '') || values.some(value => !Number.isFinite(value))) throw new Error(`${descriptor.path}: custom values must all be valid numbers.`);
  if (descriptor.integer && values.some(value => !Number.isInteger(value))) throw new Error(`${descriptor.path}: custom values must be integers.`);
  if (values.some(value => value < descriptor.min || value > descriptor.max)) throw new Error(`${descriptor.path}: custom values are outside the valid range.`);
  return [...new Set(values)];
}

function linearSweepValues(descriptor, min, max, steps, scale = 'linear') {
  if (descriptor.type !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isSafeInteger(steps) || steps < 1 || steps > 50 || min > max) throw new Error('Invalid numeric sweep range.');
  if (min < descriptor.min || max > descriptor.max) throw new Error(`${descriptor.path}: sweep bounds are outside the valid range.`);
  if (descriptor.integer && (!Number.isInteger(min) || !Number.isInteger(max))) throw new Error(`${descriptor.path}: sweep bounds must be integers.`);
  if (scale === 'log' && (!(min > 0) || !(max > 0))) throw new Error('Log sweep requires positive bounds.');
  const values = Array.from({ length: steps }, (_, index) => {
    const ratio = steps === 1 ? 0 : index / (steps - 1);
    const value = scale === 'log' ? Math.exp(Math.log(min) + (Math.log(max) - Math.log(min)) * ratio) : min + (max - min) * ratio;
    const bounded = clamp(value, descriptor.min, descriptor.max);
    return descriptor.integer ? Math.round(bounded) : Number(bounded.toPrecision(12));
  });
  return [...new Set(values)];
}

function buildSweepScenarios(baselineConfig, mode, selections, limit = SWEEP_LIMIT) {
  if (!baselineConfig || !['oat', 'grid'].includes(mode) || !Array.isArray(selections) || !selections.length) throw new Error('Sweep mode and at least one parameter selection are required.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SWEEP_LIMIT) throw new Error(`Sweep limit must be between 1 and ${SWEEP_LIMIT}.`);
  for (const selection of selections) {
    if (!selection || typeof selection.path !== 'string' || !Array.isArray(selection.values) || !selection.values.length) throw new Error('Every sweep parameter requires at least one value.');
  }
  const scenarios = [];
  const effectiveSelections = mode === 'oat'
    ? selections.map(selection => ({ ...selection, values: selection.values.filter(value => stableValue(value) !== stableValue(sweepValueAtPath(baselineConfig, selection.path))) }))
    : selections;
  const exactTotal = mode === 'oat'
    ? effectiveSelections.reduce((sum, selection) => sum + selection.values.length, 0)
    : selections.reduce((product, selection) => product > Number.MAX_SAFE_INTEGER / selection.values.length ? Number.MAX_SAFE_INTEGER : product * selection.values.length, 1);
  if (exactTotal < 1) throw new Error('Sweep requires at least one value different from the baseline.');
  const totalExact = mode === 'oat' || selections.reduce((product, selection) => product * BigInt(selection.values.length), 1n) <= BigInt(Number.MAX_SAFE_INTEGER);
  const append = changes => {
    if (scenarios.length >= limit) return;
    const config = sweepClone(baselineConfig);
    for (const [path, value] of Object.entries(changes)) setSweepPath(config, path, value);
    normalizeSweepRelations(config, Object.keys(changes));
    scenarios.push({ index: scenarios.length, changes: sweepClone(changes), config });
  };
  if (mode === 'oat') {
    for (const selection of effectiveSelections) for (const value of selection.values) append({ [selection.path]: value });
  } else {
    const walk = (index, changes) => {
      if (scenarios.length >= limit) return;
      if (index === selections.length) { append(changes); return; }
      const selection = selections[index];
      for (const value of selection.values) {
        walk(index + 1, { ...changes, [selection.path]: value });
        if (scenarios.length >= limit) break;
      }
    };
    walk(0, {});
  }
  return { mode, total: exactTotal, totalExact, omitted: Math.max(0, exactTotal - scenarios.length), scenarios };
}

function sweepPercentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function simulateSweepConfig(config) {
  const validation = validateSimulationConfig(config);
  if (!validation.valid) return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, c: config, mode: config?.mode };
  return runSimulationConfig(sweepClone(config));
}

function summarizeSweepResult(result) {
  if (!result || result.error) {
    const oom = Boolean(result?.oom || result?.state?.oom || /\boom\b/i.test(String(result?.error || '')));
    return { status: oom ? 'oom' : 'invalid', reason: String(result?.error || 'Simulation failed.'), oom, ttftMeanMs: null, ttftP50Ms: null, ttftP95Ms: null, singleTPS: null, aggregateTPS: null };
  }
  const ttfts = result.serving?.requests?.map(request => request.ttftMs).filter(Number.isFinite) || [result.ttft].filter(Number.isFinite);
  const mean = ttfts.length ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : 0;
  return {
    status: result.oom || result.state?.oom ? 'oom' : 'completed',
    reason: result.oom || result.state?.oom ? 'Simulation reached OOM or hard pressure.' : '',
    oom: Boolean(result.oom || result.state?.oom),
    ttftMeanMs: mean,
    ttftP50Ms: sweepPercentile(ttfts, 0.5),
    ttftP95Ms: sweepPercentile(ttfts, 0.95),
    singleTPS: Number(result.tps || 0),
    aggregateTPS: Number(result.serving?.throughputTPS ?? result.agg ?? result.tps ?? 0)
  };
}

function createSweepExecution(baselineConfig, plan) {
  if (!plan || !Array.isArray(plan.scenarios)) throw new Error('A valid sweep plan is required.');
  return {
    schema: 'parameter-sweep/v1',
    baselineConfig: sweepClone(baselineConfig),
    definition: { mode: plan.mode, total: plan.total, omitted: plan.omitted },
    scenarios: plan.scenarios.map(scenario => sweepClone(scenario)),
    status: 'ready',
    nextIndex: 0,
    results: []
  };
}

function advanceSweepExecution(execution) {
  if (!execution || ['paused', 'cancelled', 'completed'].includes(execution.status)) return execution;
  if (execution.nextIndex >= execution.scenarios.length) { execution.status = 'completed'; return execution; }
  execution.status = 'running';
  const scenario = execution.scenarios[execution.nextIndex];
  const simulation = simulateSweepConfig(scenario.config);
  execution.results.push({
    index: scenario.index,
    changes: sweepClone(scenario.changes),
    config: sweepClone(scenario.config),
    runId: simulation.runId || null,
    metrics: summarizeSweepResult(simulation)
  });
  execution.nextIndex++;
  if (execution.nextIndex >= execution.scenarios.length) execution.status = 'completed';
  return execution;
}

function pauseSweepExecution(execution) {
  if (execution && ['ready', 'running'].includes(execution.status)) execution.status = 'paused';
  return execution;
}

function resumeSweepExecution(execution) {
  if (execution?.status === 'paused') execution.status = execution.nextIndex >= execution.scenarios.length ? 'completed' : 'running';
  return execution;
}

function cancelSweepExecution(execution) {
  if (execution && execution.status !== 'completed') execution.status = 'cancelled';
  return execution;
}

function sweepCsvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
