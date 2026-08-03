# Hardware target presets

## Status and trust boundary

Hardware target presets identify real products and apply only values published by their vendors that map directly to simulator inputs. They are not measured serving benchmarks and do not calibrate model-runtime timing.

Component-only GPU targets do not define the host system. Selecting one therefore preserves host RAM, host DRAM bandwidth, effective PCIe bandwidth, SSD bandwidth/latency, queue depth, and runtime timing already entered by the user.

## Presets

| Target | Applied fields | Preserved manual fields | Official source |
|---|---|---|---|
| NVIDIA DGX Spark · 128 GB | Unified; host 128 GB; DRAM 273 GB/s | Effective SSD BW, latency/QD, runtime compute | https://www.nvidia.com/en-us/products/workstations/dgx-spark/ |
| Apple MacBook Pro · M5 Max · 128 GB | Unified; host 128 GB; DRAM 614 GB/s | Effective SSD BW, latency/QD, runtime compute | https://support.apple.com/en-us/126318 |
| Apple Mac Studio · M3 Ultra · 512 GB | Unified; host 512 GB; DRAM 819 GB/s | Effective SSD BW, latency/QD, runtime compute | [512 GB unified memory](https://www.apple.com/newsroom/2025/03/apple-reveals-m3-ultra-taking-apple-silicon-to-a-new-extreme/); [819 GB/s memory bandwidth](https://support.apple.com/en-us/122211) |
| NVIDIA GeForce RTX 5090 · 32 GB | Discrete; VRAM 32 GB | Host RAM/DRAM, effective PCIe, SSD service values, runtime compute | https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/ |
| AMD Radeon PRO W7900 · 48 GB | Discrete; VRAM 48 GB | Host RAM/DRAM, effective PCIe, SSD service values, runtime compute | https://www.amd.com/en/products/graphics/workstations/radeon-pro/w7900.html |

## Why some fields remain manual

- Vendor peak GPU-memory bandwidth is not the simulator's host `DRAM bandwidth` field for a discrete GPU.
- A PCIe generation is not an empirical effective transfer rate for a particular host/runtime.
- Advertised sequential SSD throughput is not automatically the effective random/service bandwidth of Expert loading.
- Product FLOPS/TOPS do not uniquely determine attention or Expert kernel latency.

Unsupported conversions are therefore left unchanged rather than presented as product facts.
