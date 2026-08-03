'use strict';

// Topology-only metadata imported from moe_model_trend_with_layers_2026-07-21.csv.
// Timing, Expert-size, resident-weight, KV, hardware, and workload values are intentionally not inferred.
const MOE_MODEL_PRESETS = Object.freeze([
  {
    "id": "mistral-mixtral-8x7b",
    "releaseDate": "2023-12-11",
    "family": "Mistral",
    "model": "Mixtral 8x7B",
    "totalParamsB": 46.7,
    "activeParamsB": 12.9,
    "transformerLayers": 32,
    "layers": 32,
    "denseLayers": 0,
    "experts": 8,
    "active": 2,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/mistralai/Mixtral-8x7B-v0.1/blob/main/config.json"
  },
  {
    "id": "deepseek-deepseekmoe-16b",
    "releaseDate": "2024-01-11",
    "family": "DeepSeek",
    "model": "DeepSeekMoE 16B",
    "totalParamsB": 16.4,
    "activeParamsB": 2.8,
    "transformerLayers": 28,
    "layers": 27,
    "denseLayers": 1,
    "experts": 64,
    "active": 6,
    "sharedExperts": 2,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/deepseek-ai/deepseek-moe-16b-base/blob/main/config.json"
  },
  {
    "id": "qwen-qwen1-5-moe-a2-7b",
    "releaseDate": "2024-03-01",
    "family": "Qwen",
    "model": "Qwen1.5-MoE-A2.7B",
    "totalParamsB": 14.3,
    "activeParamsB": 2.7,
    "transformerLayers": 24,
    "layers": 24,
    "denseLayers": 0,
    "experts": 60,
    "active": 4,
    "sharedExperts": 4,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen1.5-MoE-A2.7B/blob/main/config.json"
  },
  {
    "id": "mistral-mixtral-8x22b",
    "releaseDate": "2024-04-17",
    "family": "Mistral",
    "model": "Mixtral 8x22B",
    "totalParamsB": 141,
    "activeParamsB": 39,
    "transformerLayers": 56,
    "layers": 56,
    "denseLayers": 0,
    "experts": 8,
    "active": 2,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/mistralai/Mixtral-8x22B-v0.1/blob/main/config.json"
  },
  {
    "id": "deepseek-deepseek-v2",
    "releaseDate": "2024-05-06",
    "family": "DeepSeek",
    "model": "DeepSeek-V2",
    "totalParamsB": 236,
    "activeParamsB": 21,
    "transformerLayers": 60,
    "layers": 59,
    "denseLayers": 1,
    "experts": 160,
    "active": 6,
    "sharedExperts": 2,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V2/blob/main/config.json"
  },
  {
    "id": "deepseek-deepseek-v3-r1",
    "releaseDate": "2024-12-26",
    "family": "DeepSeek",
    "model": "DeepSeek-V3 / R1",
    "totalParamsB": 671,
    "activeParamsB": 37,
    "transformerLayers": 61,
    "layers": 58,
    "denseLayers": 3,
    "experts": 256,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 3개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/main/config.json"
  },
  {
    "id": "qwen-qwen3-235b-a22b",
    "releaseDate": "2025-04-29",
    "family": "Qwen",
    "model": "Qwen3-235B-A22B",
    "totalParamsB": 235,
    "activeParamsB": 22,
    "transformerLayers": 94,
    "layers": 94,
    "denseLayers": 0,
    "experts": 128,
    "active": 8,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/config.json"
  },
  {
    "id": "qwen-qwen3-30b-a3b",
    "releaseDate": "2025-04-29",
    "family": "Qwen",
    "model": "Qwen3-30B-A3B",
    "totalParamsB": 30,
    "activeParamsB": 3,
    "transformerLayers": 48,
    "layers": 48,
    "denseLayers": 0,
    "experts": 128,
    "active": 8,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/config.json"
  },
  {
    "id": "kimi-kimi-k2",
    "releaseDate": "2025-07-11",
    "family": "Kimi",
    "model": "Kimi K2",
    "totalParamsB": 1000,
    "activeParamsB": 32,
    "transformerLayers": 61,
    "layers": 60,
    "denseLayers": 1,
    "experts": 384,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/main/config.json"
  },
  {
    "id": "qwen-qwen3-coder-480b-a35b",
    "releaseDate": "2025-07-22",
    "family": "Qwen",
    "model": "Qwen3-Coder-480B-A35B",
    "totalParamsB": 480,
    "activeParamsB": 35,
    "transformerLayers": 62,
    "layers": 62,
    "denseLayers": 0,
    "experts": 160,
    "active": 8,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct/blob/main/config.json"
  },
  {
    "id": "glm-glm-4-5",
    "releaseDate": "2025-07-28",
    "family": "GLM",
    "model": "GLM-4.5",
    "totalParamsB": 355,
    "activeParamsB": 32,
    "transformerLayers": 92,
    "layers": 89,
    "denseLayers": 3,
    "experts": 160,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 3개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/zai-org/GLM-4.5/blob/main/config.json"
  },
  {
    "id": "glm-glm-4-5-air",
    "releaseDate": "2025-07-28",
    "family": "GLM",
    "model": "GLM-4.5-Air",
    "totalParamsB": 106,
    "activeParamsB": 12,
    "transformerLayers": 46,
    "layers": 45,
    "denseLayers": 1,
    "experts": 128,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/zai-org/GLM-4.5-Air/blob/main/config.json"
  },
  {
    "id": "openai-gpt-oss-120b",
    "releaseDate": "2025-08-05",
    "family": "OpenAI",
    "model": "gpt-oss-120b",
    "totalParamsB": 116.8,
    "activeParamsB": 5.1,
    "transformerLayers": 36,
    "layers": 36,
    "denseLayers": 0,
    "experts": 128,
    "active": 4,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/openai/gpt-oss-120b/blob/main/config.json"
  },
  {
    "id": "openai-gpt-oss-20b",
    "releaseDate": "2025-08-05",
    "family": "OpenAI",
    "model": "gpt-oss-20b",
    "totalParamsB": 20.9,
    "activeParamsB": 3.6,
    "transformerLayers": 24,
    "layers": 24,
    "denseLayers": 0,
    "experts": 32,
    "active": 4,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/openai/gpt-oss-20b/blob/main/config.json"
  },
  {
    "id": "qwen-qwen3-next-80b-a3b",
    "releaseDate": "2025-09-12",
    "family": "Qwen",
    "model": "Qwen3-Next-80B-A3B",
    "totalParamsB": 80,
    "activeParamsB": 3,
    "transformerLayers": 48,
    "layers": 48,
    "denseLayers": 0,
    "experts": 512,
    "active": 10,
    "sharedExperts": 1,
    "layerScheduleNotes": "모든 Transformer layer가 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct/blob/main/config.json"
  },
  {
    "id": "minimax-minimax-m2",
    "releaseDate": "2025-10-27",
    "family": "MiniMax",
    "model": "MiniMax M2",
    "totalParamsB": 229.9,
    "activeParamsB": 9.8,
    "transformerLayers": 62,
    "layers": 62,
    "denseLayers": 0,
    "experts": 256,
    "active": 8,
    "sharedExperts": 0,
    "layerScheduleNotes": "모든 text Transformer layer가 MoE",
    "disclosureStatus": "official open weights/config",
    "sourceUrl": "https://huggingface.co/MiniMaxAI/MiniMax-M2/blob/main/config.json"
  },
  {
    "id": "mistral-mistral-large-3",
    "releaseDate": "2025-12-02",
    "family": "Mistral",
    "model": "Mistral Large 3",
    "totalParamsB": 675,
    "activeParamsB": 41,
    "transformerLayers": 61,
    "layers": 58,
    "denseLayers": 3,
    "experts": 128,
    "active": 4,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 3개 layer dense, 이후 MoE",
    "disclosureStatus": "official params/config",
    "sourceUrl": "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/blob/main/params.json"
  },
  {
    "id": "qwen-qwen3-5-397b-a17b",
    "releaseDate": "2026-02-16",
    "family": "Qwen",
    "model": "Qwen3.5-397B-A17B",
    "totalParamsB": 397,
    "activeParamsB": 17,
    "transformerLayers": 60,
    "layers": 60,
    "denseLayers": 0,
    "experts": 512,
    "active": 10,
    "sharedExperts": 1,
    "layerScheduleNotes": "text decoder 60개가 모두 MoE; vision tower 제외",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3.5-397B-A17B/blob/main/config.json"
  },
  {
    "id": "mistral-mistral-small-4",
    "releaseDate": "2026-03-16",
    "family": "Mistral",
    "model": "Mistral Small 4",
    "totalParamsB": 119,
    "activeParamsB": 6,
    "transformerLayers": 36,
    "layers": 36,
    "denseLayers": 0,
    "experts": 128,
    "active": 4,
    "sharedExperts": 1,
    "layerScheduleNotes": "text decoder 36개가 모두 MoE; vision tower 제외",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/mistralai/Mistral-Small-4-119B-2603/blob/main/config.json"
  },
  {
    "id": "google-gemma-4-26b-a4b",
    "releaseDate": "2026-04-02",
    "family": "Google",
    "model": "Gemma 4 26B-A4B",
    "totalParamsB": 26,
    "activeParamsB": 4,
    "transformerLayers": 30,
    "layers": 30,
    "denseLayers": 0,
    "experts": 128,
    "active": 8,
    "sharedExperts": 0,
    "layerScheduleNotes": "text decoder 30개가 모두 MoE; vision tower 제외",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/google/gemma-4-26b-a4b-it/blob/main/config.json"
  },
  {
    "id": "qwen-qwen3-6-35b-a3b",
    "releaseDate": "2026-04-15",
    "family": "Qwen",
    "model": "Qwen3.6-35B-A3B",
    "totalParamsB": 35,
    "activeParamsB": 3,
    "transformerLayers": 40,
    "layers": 40,
    "denseLayers": 0,
    "experts": 256,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "text decoder 40개가 모두 MoE; vision tower 제외",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/config.json"
  },
  {
    "id": "kimi-kimi-k2-6",
    "releaseDate": "2026-04-20",
    "family": "Kimi",
    "model": "Kimi K2.6",
    "totalParamsB": 1000,
    "activeParamsB": 32,
    "transformerLayers": 61,
    "layers": 60,
    "denseLayers": 1,
    "experts": 384,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/config.json"
  },
  {
    "id": "deepseek-deepseek-v4-flash",
    "releaseDate": "2026-04-24",
    "family": "DeepSeek",
    "model": "DeepSeek-V4-Flash",
    "totalParamsB": 284,
    "activeParamsB": 13,
    "transformerLayers": 43,
    "layers": 43,
    "denseLayers": 0,
    "experts": 256,
    "active": 6,
    "sharedExperts": 1,
    "layerScheduleNotes": "43개 모두 MoE; 최초 3개는 hash routing이며 dense가 아님",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/config.json"
  },
  {
    "id": "deepseek-deepseek-v4-pro",
    "releaseDate": "2026-04-24",
    "family": "DeepSeek",
    "model": "DeepSeek-V4-Pro",
    "totalParamsB": 1600,
    "activeParamsB": 49,
    "transformerLayers": 61,
    "layers": 61,
    "denseLayers": 0,
    "experts": 384,
    "active": 6,
    "sharedExperts": 1,
    "layerScheduleNotes": "61개 모두 MoE; 최초 3개는 hash routing이며 dense가 아님",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/config.json"
  },
  {
    "id": "minimax-minimax-m3",
    "releaseDate": "2026-06-01",
    "family": "MiniMax",
    "model": "MiniMax M3",
    "totalParamsB": 428,
    "activeParamsB": 23,
    "transformerLayers": 60,
    "layers": 57,
    "denseLayers": 3,
    "experts": 128,
    "active": 4,
    "sharedExperts": 1,
    "layerScheduleNotes": "text decoder 첫 3개 dense, 이후 57개 MoE; vision encoder 제외",
    "disclosureStatus": "official open weights/config",
    "sourceUrl": "https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/config.json"
  },
  {
    "id": "glm-glm-5-2",
    "releaseDate": "2026-06-16",
    "family": "GLM",
    "model": "GLM-5.2",
    "totalParamsB": 744,
    "activeParamsB": 40,
    "transformerLayers": 78,
    "layers": 75,
    "denseLayers": 3,
    "experts": 256,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 3개 layer dense, 이후 75개 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/zai-org/GLM-5.2/blob/main/config.json"
  },
  {
    "id": "kimi-kimi-k2-7-code",
    "releaseDate": "2026-06-25",
    "family": "Kimi",
    "model": "Kimi K2.7 Code",
    "totalParamsB": 1000,
    "activeParamsB": 32,
    "transformerLayers": 61,
    "layers": 60,
    "denseLayers": 1,
    "experts": 384,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 1개 layer dense, 이후 MoE",
    "disclosureStatus": "public",
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K2.7-Code/blob/main/config.json"
  },
  {
    "id": "kimi-kimi-k3",
    "releaseDate": "2026-07-16",
    "family": "Kimi",
    "model": "Kimi K3",
    "totalParamsB": 2800,
    "activeParamsB": 104,
    "transformerLayers": 93,
    "layers": 92,
    "denseLayers": 1,
    "experts": 896,
    "active": 16,
    "sharedExperts": 2,
    "layerScheduleNotes": "text decoder 첫 1개 dense, 이후 92개 MoE; vision encoder 제외",
    "disclosureStatus": "official open weights/config",
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K3/blob/main/config.json"
  },
  {
    "id": "motif-technologies-motif-3-beta",
    "releaseDate": "2026-07-21",
    "family": "Motif Technologies",
    "model": "Motif-3-Beta",
    "totalParamsB": 314,
    "activeParamsB": 13,
    "transformerLayers": 53,
    "layers": 51,
    "denseLayers": 2,
    "experts": 384,
    "active": 8,
    "sharedExperts": 1,
    "layerScheduleNotes": "첫 2개 layer dense, 이후 51개 MoE",
    "disclosureStatus": "official beta checkpoint/config",
    "sourceUrl": "https://huggingface.co/Motif-Technologies/Motif-3-Beta/blob/main/config.json"
  }
].map(Object.freeze));

function presetHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function presetNumber(value, suffix = '') {
  return Number.isFinite(value) ? `${value}${suffix}` : 'undisclosed';
}

function renderModelPresetSummary(preset) {
  const summary = $('presetSummary');
  if (!preset) {
    summary.innerHTML = '<b>Custom / manual topology</b><br>Topology inputs are not linked to a published model.';
    return;
  }
  const safeSourceUrl = typeof preset.sourceUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(preset.sourceUrl)
    ? preset.sourceUrl
    : null;
  const source = safeSourceUrl
    ? `<a href="${presetHtml(safeSourceUrl)}" target="_blank" rel="noopener noreferrer">source config</a>`
    : 'source unavailable';
  const openWeights = /open weights\/config/i.test(String(preset.disclosureStatus));
  const calibration = openWeights
    ? '<span><b>Open weights/config:</b> routing topology is automatically applied. Runtime calibration still requires measured or explicitly assumed inputs: quantized Expert payload size, resident non-routed weights, KV bytes/token, attention/Expert timing, and hardware.</span>'
    : '<span>Published topology is automatically applied. Quantized Expert payload size, resident non-routed weights, KV bytes/token, runtime timing, and hardware remain explicit calibration inputs.</span>';
  summary.innerHTML = `<b>Topology only · ${presetHtml(preset.model)}</b><br>` +
    `${presetHtml(preset.family)} · ${presetHtml(preset.releaseDate)} · total ${presetNumber(preset.totalParamsB, 'B')} / active ${presetNumber(preset.activeParamsB, 'B')}<br>` +
    `${preset.transformerLayers} Transformer layers · ${preset.layers} MoE · ${preset.denseLayers} dense · ${preset.experts} routed Experts · top-k ${preset.active} · ${presetNumber(preset.sharedExperts)} shared<br>` +
    `${presetHtml(preset.layerScheduleNotes)} · Disclosure: ${presetHtml(preset.disclosureStatus)} · ${source}<br>` +
    calibration;
}

function initializeModelPresets() {
  const select = $('modelPreset');
  select.innerHTML = '<option value="custom">Custom / manual topology</option>' + MOE_MODEL_PRESETS
    .map(preset => `<option value="${presetHtml(preset.id)}">${presetHtml(preset.family)} · ${presetHtml(preset.model)}</option>`)
    .join('');
  select.value = 'custom';
  renderModelPresetSummary(null);
}

function markModelPresetCustom() {
  $('modelPreset').value = 'custom';
  renderModelPresetSummary(null);
}

function applySelectedModelPreset(id = $('modelPreset').value) {
  if (id === 'custom') {
    renderModelPresetSummary(null);
    return false;
  }
  const preset = MOE_MODEL_PRESETS.find(candidate => candidate.id === id);
  if (!preset) {
    $('modelPreset').value = 'custom';
    renderModelPresetSummary(null);
    return false;
  }
  $('layers').value = String(preset.layers);
  $('experts').value = String(preset.experts);
  $('active').value = String(preset.active);
  renderModelPresetSummary(preset);
  return true;
}
