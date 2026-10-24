"""RED_SIGNAL_COMPLIANCE v2.1 — trace monitor for VerifAI / simulation trajectories.

TOY educational model (TOY-TRAFFIC-SIGNAL-001); not a certified braking or traffic-law model.

Invariant: the vehicle front must not pass the stop line while the stop obligation is
active (signal red AND a stop was feasible when the obligation arose).
Robustness rho = min over obligation-active samples of (stop_line_m - front_position_m);
rho < 0 means violation. Works stand-alone on JSON traces and, if VerifAI is installed,
as a `specification_monitor` (see `VerifaiRedSignalMonitor`).

Trace format (JSON list or {"trajectory": [...]}), each sample:
  {"t": s, "position_m": m, "speed_m_per_s": m/s, "signal": "red"|"green"|"yellow"}
`stop_line_m` is a CLI/param input (default 100).
"""
import argparse
import json
import sys

T_REACT = 1.0
DECEL = 4.0
MARGIN = 2.0


def stopping_distance(v: float) -> float:
    return v * T_REACT + v * v / (2 * DECEL)


def evaluate(trajectory, stop_line_m=100.0):
    """Return a verdict dict for a trajectory."""
    obligation = False
    rho = float("inf")
    violation = None
    for i, s in enumerate(trajectory):
        pos = float(s["position_m"])
        v = float(s.get("speed_m_per_s", 0.0))
        red = str(s.get("signal", "green")).lower() == "red"
        if not red:
            obligation = False
        elif not obligation:
            # Obligation arises at red onset only if a stop is feasible (dilemma-zone exemption).
            obligation = pos <= stop_line_m and (stop_line_m - pos) >= stopping_distance(v) + MARGIN
        if obligation:
            margin = stop_line_m - pos
            rho = min(rho, margin)
            if margin < 0 and violation is None:
                violation = {"index": i, "t": s.get("t"), "position_m": pos, "speed_m_per_s": v}
    status = "VIOLATED" if violation else "SATISFIED"
    return {
        "spec_id": "RED_SIGNAL_COMPLIANCE",
        "monitor": "red_signal_stop_line",
        "status": status,
        "robustness": None if rho == float("inf") else rho,
        "witness": violation,
    }


try:  # Optional VerifAI integration.
    from verifai.monitor import specification_monitor

    class VerifaiRedSignalMonitor(specification_monitor):
        def __init__(self, stop_line_m=100.0):
            def specification(simulation):
                traj = getattr(simulation, "trajectory", simulation)
                r = evaluate(traj, stop_line_m)["robustness"]
                return float("inf") if r is None else r
            super().__init__(specification)
except ImportError:  # VerifAI not installed: stand-alone monitor still usable.
    VerifaiRedSignalMonitor = None


def demo_trace(kind):
    # Approach at 10 m/s from 0 m; light turns red at t=2 (pos 20, needs 22.5 + 2 m, has 80 m).
    out, pos, v = [], 0.0, 10.0
    for k in range(25):
        t = k * 0.5
        sig = "red" if t >= 2.0 else "green"
        out.append({"t": t, "position_m": round(pos, 3), "speed_m_per_s": round(v, 3), "signal": sig})
        if kind == "compliant" and sig == "red" and (100.0 - pos) <= stopping_distance(v) + MARGIN + 5:
            v = max(0.0, v - DECEL * 0.5)
        pos += v * 0.5
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("trace", nargs="?", help="JSON trace file; omit to use --demo")
    p.add_argument("--demo", choices=("compliant", "violating"))
    p.add_argument("--stop-line", type=float, default=100.0)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    if a.trace:
        with open(a.trace) as f:
            data = json.load(f)
        traj = data["trajectory"] if isinstance(data, dict) else data
    elif a.demo:
        traj = demo_trace(a.demo)
    else:
        p.error("provide a trace file or --demo")
    r = evaluate(traj, a.stop_line)
    print(json.dumps(r, sort_keys=True) if a.json else json.dumps(r, indent=2))
    return 0 if r["status"] == "SATISFIED" else 2


if __name__ == "__main__":
    sys.exit(main())
