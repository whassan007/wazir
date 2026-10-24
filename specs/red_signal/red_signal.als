-- RED_SIGNAL_COMPLIANCE v2.1 — Alloy 6 temporal model.
-- TOY educational model (TOY-TRAFFIC-SIGNAL-001); not a certified braking or traffic-law model.
-- Phases: Approach -> AtLine -> Stopped | Crossed.

module red_signal

abstract sig Phase {}
one sig Approach, AtLine, Stopped, Crossed extends Phase {}

abstract sig Signal {}
one sig Red, Green extends Signal {}

one sig Vehicle {
  var phase: one Phase
}

one sig Light {
  var color: one Signal
}

-- The stop obligation is active while the signal is red (assumes signal_state_available
-- and stop_feasible_within_envelope; feasibility is discharged by the Z3 obligation).
pred obligationActive { Light.color = Red }

-- ---------- Initial state ----------
pred init {
  Vehicle.phase = Approach
}

-- ---------- Actions (each with explicit frame conditions) ----------
pred advance {
  Vehicle.phase = Approach
  Vehicle.phase' = AtLine
  Light.color' = Light.color            -- frame
}

pred stop {
  Vehicle.phase = AtLine
  Vehicle.phase' = Stopped
  Light.color' = Light.color            -- frame
}

-- Compliant crossing: guarded by the stop obligation.
pred cross {
  Vehicle.phase = AtLine
  not obligationActive                  -- STOP GUARD
  Vehicle.phase' = Crossed
  Light.color' = Light.color            -- frame
}

-- Stopped vehicle may resume once the light is green.
pred resume {
  Vehicle.phase = Stopped
  not obligationActive                  -- STOP GUARD
  Vehicle.phase' = Crossed
  Light.color' = Light.color            -- frame
}

-- Environment: the light changes, vehicle frame preserved.
pred toggleLight {
  Light.color' != Light.color
  Vehicle.phase' = Vehicle.phase        -- frame
}

pred stutter {
  Vehicle.phase' = Vehicle.phase
  Light.color' = Light.color
}

-- NEGATIVE CONTROL / MUTANT TRIGGER: crossing with the stop guard relaxed.
-- Used only by the mutant system below; the compliant system never takes it.
pred crossUnguarded {
  Vehicle.phase = AtLine
  Vehicle.phase' = Crossed
  Light.color' = Light.color            -- frame
}

-- ---------- Systems ----------
pred compliantSystem {
  init
  always (advance or stop or cross or resume or toggleLight or stutter)
}

pred mutantSystem {
  init
  always (advance or stop or cross or resume or toggleLight or stutter or crossUnguarded)
}

-- Safety property P: the vehicle never enters Crossed while the obligation is active.
pred noCrossOnRed {
  always (Vehicle.phase' = Crossed and Vehicle.phase != Crossed implies not obligationActive)
}

-- ---------- Witness (non-vacuity): a red light, a stop, a green, then a crossing ----------
pred witnessStop {
  compliantSystem
  eventually (Vehicle.phase = Stopped and obligationActive)
  eventually Vehicle.phase = Crossed
}
run WitnessStop { witnessStop } for 5 but 8 steps

-- ---------- Safety check (expected: no counterexample) ----------
assert NoCrossOnRed { compliantSystem implies noCrossOnRed }
check NoCrossOnRed for 5 but 8 steps

-- ---------- Negative control (expected: COUNTEREXAMPLE found) ----------
-- If this check ever passes, the safety check above is not discriminating.
assert NoCrossOnRedMutant { mutantSystem implies noCrossOnRed }
check NoCrossOnRedMutant for 5 but 8 steps
