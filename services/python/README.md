# Python Workers Skeleton

## Included zones
- `zone2_worker.py`: Fundamental risk check stub
- `zone3_worker.py`: Pattern match score stub
- `zone4_worker.py`: Madness score stub
- `zone6_worker.py`: Historical feedback stub

## Run examples
```bash
python zone2_worker.py --symbol 005930
python zone2_worker.py --symbol 005930 --has-cb-bw true --has-krx-warning false --has-capital-impairment false
python zone3_worker.py --symbol 005930 --spike-ratio 260 --volume-power 140 --local-similarity 0.74
python zone4_worker.py --symbol 005930 --spike-ratio 260 --volume-power 140 --similarity 0.94 --sentiment 0.61 --news-velocity 77 --local-score 68
python zone6_worker.py --klass CLASS_A --stage STAGE_2
```
