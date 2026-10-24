"""VerifAI integration template adapted from upstream basic-usage documentation.

Version-sensitive: first test on the selected VerifAI + Scenic + simulator stack.
This example tests a toy separation property, not a traffic-law requirement.
"""
from dotmap import DotMap
from verifai.falsifier import generic_falsifier
from verifai.monitor import specification_monitor
from verifai.samplers import ScenicSampler
from verifai.scenic_server import ScenicServer

SCENIC_CODE = """\
model scenic.simulators.newtonian.model
ego = new Object with velocity (0, Range(5, 15))
other = new Object at (5, 0), with velocity (-10, 10)
terminate after 2 seconds
record final (distance to other) as dist
"""


class SeparationMonitor(specification_monitor):
    def __init__(self):
        def property_holds(simulation):
            return simulation.result.records["dist"] > 1
        super().__init__(property_holds)


def main():
    sampler = ScenicSampler.fromScenicCode(SCENIC_CODE)
    falsifier = generic_falsifier(
        sampler=sampler,
        monitor=SeparationMonitor(),
        falsifier_params=DotMap(n_iters=5, save_error_table=True),
        server_class=ScenicServer,
    )
    falsifier.run_falsifier()
    # Export error table, traces and configuration through the selected version's
    # documented API before drawing any conclusion from this experimental run.


if __name__ == "__main__":
    main()
