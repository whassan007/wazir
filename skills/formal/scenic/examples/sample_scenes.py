"""Sample Scenic scenes headlessly with reproducible Python/NumPy seeds."""
import argparse
import json
import random
import scenic


def main():
    p = argparse.ArgumentParser()
    p.add_argument("path")
    p.add_argument("--count", type=int, default=5)
    p.add_argument("--seed", type=int, default=42)
    opts = p.parse_args()
    if opts.count < 1 or opts.count > 1000:
        p.error("count must be 1..1000")
    random.seed(opts.seed)
    try:
        import numpy as np
        np.random.seed(opts.seed)
    except ImportError:
        pass
    scenario = scenic.scenarioFromFile(opts.path, mode2D=True)
    for i in range(opts.count):
        scene, iterations = scenario.generate()
        print(json.dumps({
            "scene_index": i,
            "seed": opts.seed,
            "rejection_iterations": iterations,
            "objects": [str(obj.position) for obj in scene.objects],
        }))


if __name__ == "__main__":
    main()
