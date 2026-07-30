# AFM 3 Core Advanced Simulation Model

## Scope

이 문서는 Simulator V1.2의 AFM 3 Core Advanced 모델에서 사용하는 가정과 계산식을 정의합니다.

Constant Table과 실제 rasterized weight layout이 없으므로 **정확한 Expert ID trace simulator가 아니라 aggregate window model**입니다.

## Confirmed configuration

```json
{
  "active_experts": 46,
  "shared_experts": 23,
  "expert_selection_frequency": 32,
  "active_ffn_dim": 11776,
  "ffn_split_chunks": 2,
  "num_layers": 44,
  "num_ffns": 3,
  "expert_size": 256,
  "hidden_dim": 1536,
  "weight_bits": 2
}
```

Interpretation:

- Active 46 includes Shared 23.
- Routed Active Experts = 23.
- `num_ffns=3` means Gate, Up and Down projections.
- `expert_size=256` means 256 FFN channels, not MB.
- Selection frequency counts generated tokens only.
- Token 32 completes using the old set; Token 33 uses the new set.
- Expert intersection is retained and only the set difference is loaded.
- FFN computation is split into two equal-dimension chunks.

## Weight size

### One global Expert channel group

```text
Parameters / Expert
= layers × projections × hidden_dim × expert_width
= 44 × 3 × 1,536 × 256
= 51,904,512 parameters
```

```text
Raw bytes / Expert
= parameters × 2 bits / 8
= 12,976,128 bytes
= 12.976128 MB
```

With packing factor `P`:

```text
Packed Expert GB
= 51,904,512 × 2 / 8 / 1e9 × P
```

Default `P=1.08`, so one Expert is approximately 14.012MB.

### Active FFN

```text
Active FFN parameters
= 44 × 3 × 1,536 × 11,776
= 2,387,804,160 parameters
```

## Selection windows

For output token index `i`, zero based:

```text
Boundary(i) = i > 0 and i mod 32 = 0
```

Thus the first boundary is the 33rd generated token.

```text
Periodic reselection count
= floor((output_tokens − 1) / 32)
```

## Synthetic overlap model

Total Expert Pool is unknown. The simulator therefore avoids generating real Expert IDs.

For each boundary:

```text
Expected changed experts
= routed_active × (1 − overlap)
```

A deterministic seeded stochastic rounding converts this to an integer.

```text
Retained experts = routed_active − changed experts
Read bytes = changed experts × packed Expert bytes
```

Profiles:

| Profile | Overlap |
|---|---:|
| Stable task | 0.80 |
| Normal generation | 0.65 |
| Topic transition | 0.30 |
| Full replacement | 0.00 |

## Timing model

### Steady token

```text
Steady TPOT
= Attention time
+ Active FFN compute time
+ Merge/runtime time
```

The FFN compute input is divided into `ffn_split_chunks` for reporting and optional experimental overlap. In the conservative mode, the chunks execute sequentially and their total remains the configured FFN compute time.

### Initial TTFT

```text
TTFT
= Initial selector latency
+ Initial Routed Expert read
+ Initial materialization/patch
+ Prompt prefill
+ First decode token
```

Shared Experts are assumed resident before the request. Initial Routed read loads all 23 Routed Active Experts.

### Boundary token

```text
Boundary TPOT
= Steady TPOT
+ Periodic selector latency
+ Delta NAND read time
+ Materialization/patch time
```

Sequential conservative mode exposes the full selection and load path.

Experimental overlap mode uses:

```text
Exposed boundary overhead
= selector
+ max(0, read + patch − one chunk compute)
```

This overlap mode is not claimed to match an Apple implementation.

## Memory model

AFM 3 mode uses Unified Memory.

```text
Unified memory footprint
= Common resident weights
+ Shared Expert weights
+ Current Routed Expert weights
+ Optional next-set double buffer
+ KV Cache
+ Runtime reserve
+ OS reserve
+ Workspace
```

`Common resident weights` is a calibration input because it cannot be recovered from the supplied configuration.

The displayed full-model NAND size is estimated as:

```text
20B × 2 bits / 8 × packing factor
```

It does not account for mixed precision, non-weight assets or file-system metadata.

## Validation

The in-app Self-test verifies:

- `46 × 256 = 11,776`
- Expert raw size is 12.976128MB at 2-bit
- 32 output tokens produce no periodic reselection
- Token 33 is the first boundary
- Boundary TPOT exceeds Steady TPOT when overlap is below 100%
- 100% overlap produces zero periodic NAND read
- 2-bit Expert bytes are half of 4-bit
- Real-time playback delay is not compressed

## Known unknowns

- Total Expert Pool
- Whether the Expert mask is global across all layers or per-layer
- Actual rasterized file layout and contiguous-read efficiency
- Actual common resident parameter size
- Selector implementation and latency
- Materialization kernel and bandwidth
- Whether two chunks correspond to functional groups or only execution tiling
- Actual overlap distribution by prompt and generation phase

These values should be replaced by measured traces when available.
