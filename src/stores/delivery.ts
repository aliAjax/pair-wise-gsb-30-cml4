import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { mergeBatches, recomputeAfterResolution } from "../mergeEngine";
import type {
  ConflictEntry,
  DeliveryPlan,
  LoadingBatch,
  SyncLog,
  Vehicle
} from "../types";

const STORAGE_KEY = "hxwlfront-19-offline-sync-v1";

interface PersistShape {
  plans: DeliveryPlan[];
  vehicles: Vehicle[];
  batches: LoadingBatch[];
  conflicts: ConflictEntry[];
  logs: SyncLog[];
  processedReceipts: string[];
}

function seedVehicles(): Vehicle[] {
  return [
    { plate: "京A·1001", capacity: 20, driver: "王建国", remark: "92/95 汽油罐车" },
    { plate: "京B·2002", capacity: 15, driver: "刘长海", remark: "柴油罐车" },
    { plate: "京C·3003", capacity: 30, driver: "赵勇", remark: "大容量柴汽油通用" },
    { plate: "京D·4004", capacity: 28, driver: "孙伟", remark: "汽油罐车" }
  ];
}

function seedPlans(): DeliveryPlan[] {
  const now = Date.now();
  const iso = (offsetMin: number) => new Date(now - offsetMin * 60000).toISOString();
  return [
    {
      id: crypto.randomUUID(),
      code: "PC-1001",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveAt: "2026-10-05",
      status: "待发车",
      plate: "京A·1001",
      version: 1,
      updatedBy: "调度员·张敏",
      updatedAt: iso(200),
      notes: "夜间计划，等待司机装车回执"
    },
    {
      id: crypto.randomUUID(),
      code: "PC-1002",
      station: "机场站",
      fuel: "柴油",
      tons: 12,
      arriveAt: "2026-10-05",
      status: "待发车",
      plate: "京B·2002",
      version: 1,
      updatedBy: "调度员·张敏",
      updatedAt: iso(190),
      notes: "小车配送，注意 15 吨容量上限"
    },
    {
      id: crypto.randomUUID(),
      code: "PC-1003",
      station: "新区站",
      fuel: "95号汽油",
      tons: 24,
      arriveAt: "2026-10-04",
      status: "运输中",
      plate: "京C·3003",
      version: 3,
      updatedBy: "调度员·张敏",
      updatedAt: iso(300),
      notes: "白班已确认发车，在途"
    },
    {
      id: crypto.randomUUID(),
      code: "PC-1004",
      station: "城东站",
      fuel: "95号汽油",
      tons: 20,
      arriveAt: "2026-10-05",
      status: "待发车",
      plate: "京D·4004",
      version: 1,
      updatedBy: "调度员·张敏",
      updatedAt: iso(180),
      notes: "夜间计划"
    }
  ];
}

/** 预置一批夜间离线装车批次：含正常、重复回执、超容量、撞在途等情形 */
function seedBatches(plans: DeliveryPlan[]): LoadingBatch[] {
  const ver = (code: string) => plans.find((p) => p.code === code)!.version;
  const night = "2026-10-04T23:40:00.000Z";
  const make = (
    receiptId: string,
    planCode: string,
    plate: string,
    tons: number,
    driver: string,
    loadedAt: string
  ): LoadingBatch => ({
    id: crypto.randomUUID(),
    receiptId,
    planCode,
    snapshotVersion: ver(planCode),
    plate,
    tons,
    driver,
    loadedAt,
    status: "待同步"
  });
  return [
    make("HK-5001", "PC-1001", "京A·1001", 18, "王建国", night),
    // 恢复后旧车次又发了一遍：同一回执
    make("HK-5001", "PC-1001", "京A·1001", 18, "王建国", "2026-10-05T06:05:00.000Z"),
    // 实装 16 吨，超过京B·2002 的 15 吨容量
    make("HK-5002", "PC-1002", "京B·2002", 16, "刘长海", "2026-10-05T00:10:00.000Z"),
    // 计划已在途（PC-1003 运输中），不得覆盖/重复发车
    make("HK-5003", "PC-1003", "京C·3003", 24, "赵勇", "2026-10-05T01:20:00.000Z"),
    // 装车时依据 v1；恢复后会被另一调度员改派（演示用按钮触发）
    make("HK-5004", "PC-1004", "京D·4004", 20, "孙伟", "2026-10-05T02:00:00.000Z")
  ];
}

function loadState(): PersistShape {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as PersistShape;
    } catch {
      // 落库损坏则重新播种
    }
  }
  const vehicles = seedVehicles();
  const plans = seedPlans();
  const batches = seedBatches(plans);
  return { plans, vehicles, batches, conflicts: [], logs: [], processedReceipts: [] };
}

export const useDeliveryStore = defineStore("delivery", () => {
  const initial = loadState();
  const plans = ref<DeliveryPlan[]>(initial.plans);
  const vehicles = ref<Vehicle[]>(initial.vehicles);
  const batches = ref<LoadingBatch[]>(initial.batches);
  const conflicts = ref<ConflictEntry[]>(initial.conflicts);
  const logs = ref<SyncLog[]>(initial.logs);
  const processedReceipts = ref<Set<string>>(new Set(initial.processedReceipts));

  // 夜间断网：默认离线
  const online = ref(false);
  const currentOperator = ref("调度员·张敏");
  const lastSyncAt = ref<string>("");

  const pendingBatches = computed(() => batches.value.filter((b) => b.status === "待同步"));
  const openConflicts = computed(() => conflicts.value.filter((c) => c.status === "未决"));
  const inTransitCount = computed(
    () => plans.value.filter((p) => p.status === "运输中" || p.status === "已到站").length
  );

  function persist() {
    const data: PersistShape = {
      plans: plans.value,
      vehicles: vehicles.value,
      batches: batches.value,
      conflicts: conflicts.value,
      logs: logs.value,
      processedReceipts: [...processedReceipts.value]
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ---------- 计划维护（任一调度员的改派/改吨都会使版本 +1） ----------

  function updatePlan(payload: { id: string; plate?: string; tons?: number; notes?: string }) {
    const plan = plans.value.find((p) => p.id === payload.id);
    if (!plan) return;
    let changed = false;
    if (payload.plate !== undefined && payload.plate !== plan.plate) {
      plan.plate = payload.plate;
      changed = true;
    }
    if (payload.tons !== undefined && Number(payload.tons) !== plan.tons) {
      plan.tons = Number(payload.tons);
      changed = true;
    }
    if (payload.notes !== undefined) plan.notes = payload.notes;
    if (changed) {
      plan.version += 1;
      plan.updatedBy = currentOperator.value;
      plan.updatedAt = nowIso();
    }
    persist();
  }

  /** 演示：夜间断网期间，另一名调度员在他端改派了 PC-1004 */
  function simulateRemoteReassign() {
    const plan = plans.value.find((p) => p.code === "PC-1004");
    if (!plan) return;
    plan.plate = "京C·3003"; // 改派给在本站待命的另一辆车
    plan.tons = 22;
    plan.version += 1;
    plan.updatedBy = "调度员·李强";
    plan.updatedAt = nowIso();
    plan.notes = "夜间紧急改派（李强）：京D·4004 → 京C·3003";
    pushLog({
      receiptId: "-",
      planCode: plan.code,
      result: "冲突挂起",
      detail: `（他端操作）李强改派并升至 v${plan.version}，本地装车批次仍基于旧版本`
    });
    persist();
  }

  function updateVehicleCapacity(plate: string, capacity: number) {
    const v = vehicles.value.find((item) => item.plate === plate);
    if (v) {
      v.capacity = Number(capacity);
      persist();
    }
  }

  // ---------- 司机离线装车：按车次暂存 ----------

  function addOfflineBatch(payload: {
    planCode: string;
    plate: string;
    tons: number;
    driver: string;
    receiptId?: string;
  }) {
    const plan = plans.value.find((p) => p.code === payload.planCode);
    if (!plan) return;
    const receipt = payload.receiptId?.trim() || `HK-${Date.now().toString().slice(-6)}`;
    batches.value.unshift({
      id: crypto.randomUUID(),
      receiptId: receipt,
      planCode: payload.planCode,
      snapshotVersion: plan.version, // 暂存装车时依据的计划版本
      plate: payload.plate.trim(),
      tons: Number(payload.tons),
      driver: payload.driver,
      loadedAt: nowIso(),
      status: "待同步"
    });
    persist();
  }

  // ---------- 恢复联网：按计划版本与车牌合并 ----------

  function pushLog(entry: Omit<SyncLog, "id" | "at">) {
    logs.value.unshift({ id: crypto.randomUUID(), at: nowIso(), ...entry });
  }

  /**
   * 同步所有待处理批次：
   * 回执幂等（只处理一次）→ 按计划版本+车牌比对 → 无冲突合并确认发车，冲突入台账。
   * 返回处理计数供界面提示。
   */
  function syncPendingBatches() {
    const pending = batches.value.filter((b) => b.status === "待同步");
    if (pending.length === 0) return { merged: 0, duplicated: 0, conflicted: 0 };

    const outcome = mergeBatches(pending, {
      plans: plans.value,
      vehicles: vehicles.value,
      processedReceipts: processedReceipts.value,
      operator: currentOperator.value,
      now: nowIso()
    });

    // 仅当某车次无冲突合并时才替换计划（引擎内部已保证冲突不改计划）
    plans.value = outcome.plans;
    conflicts.value = [...conflicts.value, ...outcome.conflicts];
    logs.value = [...outcome.logs.reverse(), ...logs.value];
    processedReceipts.value = outcome.processedReceipts;

    let merged = 0;
    let duplicated = 0;
    let conflicted = 0;
    for (const batch of batches.value) {
      const result = outcome.batchResults.get(batch.id);
      if (!result || batch.status !== "待同步") continue;
      batch.status = result.status;
      batch.resultNote = result.note;
      if (result.status === "已合并") merged += 1;
      else if (result.status === "重复跳过") duplicated += 1;
      else if (result.status === "冲突挂起") conflicted += 1;
    }

    lastSyncAt.value = nowIso();
    persist();
    return { merged, duplicated, conflicted };
  }

  /** 断网/恢复切换；恢复时自动同步，返回本次同步计数 */
  function setOnline(value: boolean) {
    online.value = value;
    if (value) return syncPendingBatches();
    return { merged: 0, duplicated: 0, conflicted: 0 };
  }

  // ---------- 冲突台账：处理后按最新计划重算 ----------

  /** 调度员修正本地批次（换车/调整吨数），不直接动计划 */
  function fixBatch(receiptId: string, patch: { plate?: string; tons?: number }) {
    const batch = batches.value.find((b) => b.receiptId === receiptId);
    if (!batch) return;
    if (patch.plate) batch.plate = patch.plate;
    if (patch.tons !== undefined) batch.tons = Number(patch.tons);
    batch.dispatcherAdjusted = true;
    batch.resultNote = "调度员已在台账显式修正批次，等待按最新计划重算";
    persist();
  }

  /**
   * 冲突处理完后按最新计划重算：
   * 重新比对版本/车牌/容量/在途状态；通过则合并并确认发车，否则继续挂起并刷新原因。
   */
  function recomputeConflict(conflictId: string) {
    const conflict = conflicts.value.find((c) => c.id === conflictId);
    if (!conflict || conflict.status !== "未决") return;
    const batch = batches.value.find((b) => b.receiptId === conflict.receiptId);
    if (!batch) return;

    const result = recomputeAfterResolution(
      batch,
      plans.value,
      vehicles.value,
      currentOperator.value,
      nowIso()
    );

    if (result.merged) {
      plans.value = result.plans;
      conflict.status = "已解决";
      conflict.resolution = "按最新计划重算通过，已合并并确认发车";
      conflict.resolvedAt = nowIso();
      conflict.reasons = [];
      batch.status = "已合并";
      batch.resultNote = "冲突处理后重算通过，已按最新计划合并发车";
      pushLog({
        receiptId: batch.receiptId,
        planCode: batch.planCode,
        result: "合并",
        detail: "冲突处理完成，按最新计划重算合并并确认发车"
      });
    } else {
      // 仍未通过：保持未决挂起，只刷新冲突原因，批次继续留在台账
      conflict.reasons = result.reasons;
      batch.resultNote = `重算未通过：${result.reasons.join("、")}`;
      pushLog({
        receiptId: batch.receiptId,
        planCode: batch.planCode,
        result: "冲突挂起",
        detail: `处理后重算仍有冲突：${result.reasons.join("、")}`
      });
    }
    persist();
  }

  /** 作废冲突（如回执无效），台账留痕，批次不再参与发车 */
  function discardConflict(conflictId: string) {
    const conflict = conflicts.value.find((c) => c.id === conflictId);
    if (!conflict) return;
    conflict.status = "已作废";
    conflict.resolution = "调度员核实后作废，不并入在途计划";
    conflict.resolvedAt = nowIso();
    const batch = batches.value.find((b) => b.receiptId === conflict.receiptId);
    if (batch) batch.resultNote = "回执已作废，不予发车";
    pushLog({
      receiptId: conflict.receiptId,
      planCode: conflict.planCode,
      result: "重复跳过",
      detail: "冲突批次被调度员作废"
    });
    persist();
  }

  function resetDemo() {
    localStorage.removeItem(STORAGE_KEY);
    const seedVehicleList = seedVehicles();
    const seedPlanList = seedPlans();
    const seedBatchList = seedBatches(seedPlanList);
    plans.value = seedPlanList;
    vehicles.value = seedVehicleList;
    batches.value = seedBatchList;
    conflicts.value = [];
    logs.value = [];
    processedReceipts.value = new Set();
    lastSyncAt.value = "";
    online.value = false;
  }

  return {
    // state
    plans,
    vehicles,
    batches,
    conflicts,
    logs,
    processedReceipts,
    online,
    currentOperator,
    lastSyncAt,
    // getters
    pendingBatches,
    openConflicts,
    inTransitCount,
    // actions
    updatePlan,
    simulateRemoteReassign,
    updateVehicleCapacity,
    addOfflineBatch,
    syncPendingBatches,
    setOnline,
    fixBatch,
    recomputeConflict,
    discardConflict,
    resetDemo
  };
});
