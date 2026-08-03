# MoE topology preset integration spec

## Status

Accepted for V1.5 Alpha.

## Source

- Repository dataset: `data/moe_model_trend_with_layers_2026-07-21.csv`
- SHA-256: `47033e8b10be92661e417b3d3105eaedaa9960f3faa2ab022f2945c6c7d91789`
- Dataset rows: 31
- Eligible topology presets: 29
- Excluded because required topology is undisclosed: Qwen3.7-Max, Qwen3.8-Max-Preview
- Kimi K3 was refreshed on 2026-07-31 from the official [`moonshotai/Kimi-K3` model card](https://huggingface.co/moonshotai/Kimi-K3) and [`config.json`](https://huggingface.co/moonshotai/Kimi-K3/blob/main/config.json) after its open-weight release. The UI identifies that open weights/config make the routing topology sourceable, while quantized payload size, resident non-routed weights, KV bytes/token, runtime kernel timing, and hardware still require measured or explicitly assumed calibration.
- Each preset retains its supplied release date, family, model name, parameter metadata, layer schedule note, disclosure status, and source URL.

The CSV is input metadata, not an independent performance oracle.
`npm run check` executes `tools/check-presets.cjs`, which deterministically verifies all retained CSV metadata, source URLs, the 31-row source count, the 29 eligible rows, and the two named exclusions against `presets.js`.

## Goal

Allow a Colibri user to select a disclosed MoE model topology without manually transcribing layer and routing counts.

## Mapping contract

Selecting a preset changes only:

| CSV field | Simulator control |
|---|---|
| `moe_layers` | MoE layers (`layers`) |
| `routed_experts_per_moe_layer` | Experts / layer (`experts`) |
| `topk_routed_per_moe_layer` | Active routed experts / token (`active`) |

The preset summary displays, but does not use as a timing calibration:

- total and active parameter counts;
- transformer, MoE, and dense-layer counts;
- shared Expert count;
- layer schedule note;
- disclosure status and source URL.

## Explicit exclusions

A preset must not infer or overwrite:

- Expert size in MB;
- resident non-routed weights;
- KV bytes per token;
- attention or Expert compute latency;
- weight precision or compression;
- cache placement and hardware settings;
- workload, concurrency, prefetch, or memory policy.

The supplied table does not uniquely determine those quantities. Deriving them from total/active parameter counts would create unsupported assumptions. Dense FFN layers and shared Experts remain metadata because the Colibri engine currently models routed MoE layers only.

## Behavior

1. The default selection is `Custom / manual topology`; existing defaults remain unchanged.
2. Selecting an eligible model updates the three mapped controls and renders an accessible topology-only summary with the source link.
3. Editing any mapped control switches the selection back to Custom.
4. Preset application must produce finite safe integers accepted by existing strict config validation.
5. Models lacking any required mapped field are not selectable.
6. Applying a preset must not start playback; it may recompute and render the static result.

## Acceptance criteria

- Exactly 29 eligible presets are available, plus Custom.
- Kimi K3 maps its official text-decoder topology to 92 MoE layers, 896 Experts/layer, and top-k 16; the dense first layer and vision encoder remain metadata only.
- DeepSeek-V3 / R1 maps to 58 layers, 256 Experts/layer, top-k 8.
- Mixtral 8x7B maps to 32 layers, 8 Experts/layer, top-k 2.
- Applying a preset preserves Expert size, resident weights, KV size, workload, and hardware controls.
- Manual edits return the selector to Custom.
- The summary states `Topology only` and does not present the preset as calibrated performance data.
- The summary displays disclosure status and a scheme-checked HTTPS source link.
- Mobile Run controls remain in normal document flow and do not cover the source or calibration warning.
- Existing simulation, accessibility, import/replay, and CI gates remain green.
