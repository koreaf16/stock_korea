# Python Workers Skeleton

## Included zones
- `zone2_worker.py`: Fundamental risk check stub
- `zone3_worker.py`: Pattern match score stub
- `zone4_worker.py`: Madness score stub
- `zone6_worker.py`: Historical feedback stub
- `zone_integrated_miner.py`: RAW -> GPU vectorization(Z1~Z4) -> `TB_INTEGRATED_VECTOR_STATION` 단일 insert

## Run examples
```bash
python zone2_worker.py --symbol 005930
python zone2_worker.py --symbol 005930 --has-cb-bw true --has-krx-warning false --has-capital-impairment false
python zone3_worker.py --symbol 005930 --spike-ratio 260 --volume-power 140 --local-similarity 0.74
python zone4_worker.py --symbol 005930 --spike-ratio 260 --volume-power 140 --similarity 0.94 --sentiment 0.61 --news-velocity 77 --local-score 68
python zone6_worker.py --klass CLASS_A --stage STAGE_2
python zone_integrated_miner.py --symbol 005930 --event-ts 2026-03-07T01:10:00Z
python zone_integrated_miner.py --symbol 005930 --dry-run --allow-cpu-fallback --skip-gpu-name-check
```

## Integrated Miner deps (RTX 3090)
```bash
pip install -r services/python/requirements-integrated-miner.txt
```
