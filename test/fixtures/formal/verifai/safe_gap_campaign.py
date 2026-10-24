from verifai.monitor import specification_monitor

class SafeGap(specification_monitor):
    def __init__(self):
        super().__init__(lambda traj: min(s["gap"] - 2.0 for s in traj))

monitor = SafeGap

def simulate(params, seed):
    gap, traj = 20.0, []
    for _ in range(10):
        gap -= params["closing_speed"]
        traj.append({"gap": gap})
    return traj
