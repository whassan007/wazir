"""Demonstrate symbolic counterexample search; not an AV safety assurance."""
import argparse
import json
import sys

from z3 import And, BoolVal, Not, Real, RealVal, Solver, sat, unsat


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", choices=("buggy", "guarded"), required=True)
    args = parser.parse_args()

    speed = Real("speed_m_per_s")
    distance = Real("distance_to_stopline_m")
    reaction = RealVal("1")
    deceleration = RealVal("4")
    margin = RealVal("2")
    stopping_distance = speed * reaction + speed * speed / (2 * deceleration)
    red = BoolVal(True)  # This demonstration considers red-signal states only.

    solver = Solver()
    solver.set(timeout=5000)
    solver.add(speed >= 0, speed <= 30, distance >= 0, distance <= 200)
    # A stop is feasible under this simplified physical model.
    can_stop = distance >= stopping_distance + margin
    solver.add(can_stop)
    if args.candidate == "buggy":
        proceed = speed < 4  # Deliberately incorrect policy.
    else:
        proceed = Not(red)  # Simplified corrected red-signal guard.
    # Find A and implementation and NOT P (P = cannot proceed when red and can stop).
    solver.add(And(red, proceed))

    outcome = solver.check()
    result = {
        "candidate": args.candidate,
        "property": "red_and_can_stop_implies_not_proceed",
        "scope": "0 <= speed <= 30 m/s; 0 <= distance <= 200 m; toy dynamics",
        "solver_result": str(outcome),
    }
    if outcome == sat:
        m = solver.model()
        result.update(status="COUNTEREXAMPLE", witness={
            "speed_m_per_s": str(m.eval(speed, model_completion=True)),
            "distance_to_stopline_m": str(m.eval(distance, model_completion=True)),
        })
        print(json.dumps(result, indent=2))
        return 2
    if outcome == unsat:
        result["status"] = "BOUNDED_PASS"
        print(json.dumps(result, indent=2))
        return 0
    result.update(status="UNKNOWN", reason=solver.reason_unknown())
    print(json.dumps(result, indent=2))
    return 3


if __name__ == "__main__":
    sys.exit(main())
