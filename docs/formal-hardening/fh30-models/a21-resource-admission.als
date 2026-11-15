module a21_resource_admission

sig ModelSlot {
  cost: Int
}

var sig LoadedModels in ModelSlot {}
var sig PinnedModels in ModelSlot {}

pred init {
  no LoadedModels
  no PinnedModels
}

fun usedMemory: Int {
  sum m: LoadedModels | m.cost
}

pred loadModel[m: ModelSlot, cap: Int] {
  m not in LoadedModels
  m.cost > 0
  plus[usedMemory, m.cost] =< cap
  LoadedModels' = LoadedModels + m
  PinnedModels' = PinnedModels
}

pred pinModel[m: ModelSlot] {
  m in LoadedModels
  LoadedModels' = LoadedModels
  PinnedModels' = PinnedModels + m
}

pred evictModel[m: ModelSlot] {
  m in LoadedModels
  m not in PinnedModels
  LoadedModels' = LoadedModels - m
  PinnedModels' = PinnedModels
}

pred stutter {
  LoadedModels' = LoadedModels
  PinnedModels' = PinnedModels
}

fact validCosts {
  all m: ModelSlot | m.cost >= 1 and m.cost =< 4
}

fact traces {
  init
  always (
    (some m: ModelSlot | loadModel[m, 6]) or
    (some m: ModelSlot | pinModel[m]) or
    (some m: ModelSlot | evictModel[m]) or
    stutter
  )
}

run WitnessConcurrentAdmissionAndEviction {
  eventually (#LoadedModels = 2 and some PinnedModels)
} for 3 ModelSlot, 5 Int, 6 steps

assert CapacityAndPinInvariant {
  always (usedMemory =< 6 and PinnedModels in LoadedModels)
}

check CapacityAndPinInvariant for 3 ModelSlot, 5 Int, 6 steps
