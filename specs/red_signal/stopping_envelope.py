"""RED_SIGNAL_COMPLIANCE v2.1 — Z3 stopping-envelope obligation.

TOY educational model (TOY-TRAFFIC-SIGNAL-001); not a certified braking or traffic-law model.

Stopping distance: v * t_react + v^2 / (2 * decel), plus a safety margin.
Assumptions A: bounded speed/distance, positive braking limits (braking_limits_valid),
signal state known (signal_state_available).
Precondition: red signal and a stop is feasible within the envelope.
Property P: red && stop feasible ==> vehicle does not proceed past the stop line.

Checks:
  1. Vacuity probe: A is SAT and A /\\ precondition is SAT (else VACUOUS).
  2. Safety: A /\\ impl /\\ not P.  sat -> COUNTEREXAMPLE (with witness), unsat -> PROVED.

Exit codes: 0 PROVED, 2 COUNTEREXAMPLE, 3 UNKNOWN, 4 VACUOUS.
"""
import argparse
import json
import sys

from z3 import And, Bool, Not, Or, Real, RealVal, Solver, sat, unsat

T_REACT = RealVal("1")   # s
DECEL = RealVal("4")     # m/s^2
MARGIN = RealVal("2")    # m


def build():
    v = Real("speed_m_per_s")
    d = Real("distance_to_stopline_m")
    red = Bool("red")
    stopping = v * T_REACT + v * v / (2 * DECEL)
    assumptions = And(v >= 0, v <= 30, d >= 0, d <= 200, DECEL > 0, T_REACT >= 0, MARGIN >= 0)
    feasible = d >= stopping + MARGIN
    return v, d, red, stopping, assumptions, feasible


def candidate_proceed(name, v, d, red, stopping):
    if name == "buggy":
        # Deliberately incorrect: low speed is treated as license to proceed on red.
        return Or(Not(red), v < 4)
    if name == "mutant":
        # Negative control: guarded policy with ONE guard relaxed — the dilemma-zone
        # threshold is doubled, so it proceeds on red even where a stop is feasible.
        return Or(Not(red), d < 2 * stopping + MARGIN)
    # guarded: proceed only when not red, or when stopping is infeasible (dilemma zone).
    return Or(Not(red), d < stopping + MARGIN)


def model_val(m, x):
    return str(m.eval(x, model_completion=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", choices=("buggy", "guarded", "mutant"), required=True)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON only")
    args = parser.parse_args()

    v, d, red, stopping, A, feasible = build()
    precondition = And(red, feasible)
    proceed = candidate_proceed(args.candidate, v, d, red, stopping)
    prop = Not(And(precondition, proceed))  # P

    result = {
        "spec_id": "RED_SIGNAL_COMPLIANCE",
        "spec_version": "2.1",
        "obligation": "stopping_envelope",
        "candidate": args.candidate,
        "property": "red_and_stop_feasible_implies_not_proceed",
        "model": "v*t_react + v^2/(2*decel) + margin; t_react=1, decel=4, margin=2",
        "scope": "0 <= speed <= 30 m/s; 0 <= distance <= 200 m; toy dynamics",
    }

    vac = {}
    for label, formula in (("A", A), ("A_and_precondition", And(A, precondition))):
        s = Solver()
        s.set(timeout=5000)
        s.add(formula)
        vac[label] = str(s.check())
    result["vacuity_probe"] = vac
    if vac["A"] != "sat" or vac["A_and_precondition"] != "sat":
        result["status"] = "VACUOUS"
        return emit(result, args.json, 4)

    s = Solver()
    s.set(timeout=5000)
    s.add(A, Not(prop))  # A /\ impl /\ not P (impl folded into prop via `proceed`)
    outcome = s.check()
    result["solver_result"] = str(outcome)
    if outcome == sat:
        m = s.model()
        result["status"] = "COUNTEREXAMPLE"
        result["witness"] = {
            "speed_m_per_s": model_val(m, v),
            "distance_to_stopline_m": model_val(m, d),
            "red": model_val(m, red),
            "stopping_distance_m": model_val(m, stopping),
        }
        return emit(result, args.json, 2)
    if outcome == unsat:
        result["status"] = "PROVED"
        return emit(result, args.json, 0)
    result["status"] = "UNKNOWN"
    result["reason"] = s.reason_unknown()
    return emit(result, args.json, 3)


def emit(result, as_json, code):
    if as_json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
