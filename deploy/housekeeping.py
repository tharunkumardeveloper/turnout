# Server-mode demo housekeeping, run with Flagsmith's own code (python manage.py shell < this file).
# The always-on autopilot starts ~40 experiments an hour; each leaves a rollout segment that stays in the project, so
# the environment document every proxy downloads every 5 s (and every experiment list) grows without end. This keeps
# the KEEP most recent experiments per flag, and for older ones that are completed AND have a Turnout decision
# snapshot (SNAPSHOTTED, ids), deletes the experiment and soft-deletes its rollout segment when no flag override
# still uses it. Their records stay in Turnout's ledger and snapshots. DRY_RUN=1 only counts.
import os
from experimentation.models import Experiment
from features.models import FeatureSegment

keep = int(os.environ.get('KEEP', '10'))
dry = os.environ.get('DRY_RUN') == '1'
snap = {int(x) for x in os.environ.get('SNAPSHOTTED', '').split(',') if x.strip().isdigit()}
seen = {}
removed_exp = removed_seg = 0
for e in Experiment.objects.all_with_deleted().order_by('-id'):
    key = (e.feature_id, e.environment_id)
    if e.deleted_at is None:
        seen[key] = seen.get(key, 0) + 1
        if seen[key] <= keep or e.status != 'completed' or e.id not in snap:
            continue
        if not dry:
            e.delete()
        removed_exp += 1
    seg = e.rollout_segment
    if seg is None or seg.deleted_at is not None or not seg.is_system_segment:
        continue
    if FeatureSegment.objects.filter(segment=seg).exists():
        continue
    if not dry:
        seg.delete()
    removed_seg += 1
print(f"{'dry run: would remove' if dry else 'removed'} {removed_exp} experiments and {removed_seg} rollout segments (kept the latest {keep} per flag)")
