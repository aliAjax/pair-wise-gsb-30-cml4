import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  ConflictRecord,
  DeliveryPlan,
  LoadingBatch,
  SyncLogEntry,
  Vehicle,
} from "./types";
import { confirmDeparture, evaluateBatch, resolveConflict, runSync } from "./lib/sync";
import {
  STORAGE_KEY,
  localPlanV2,
  seedBatches,
  serverPlanV3,
  vehicles as seedVehicles,
} from "./seed";

interface PersistShape {
  online: boolean;
  localPlan: DeliveryPlan;
  serverPlan: DeliveryPlan;
  vehicles: Vehicle[];
  batches: LoadingBatch[];
  conflicts: ConflictRecord[];
  processedReceipts: string[];
  logs: SyncLogEntry[];
  lastSyncAt: string | null;
}

function uid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialState(): PersistShape {
  return {
    // 场景从“夜间断网”开始
    online: false,
    localPlan: structuredClone(localPlanV2),
    serverPlan: structuredClone(serverPlanV3),
    vehicles: structuredClone(seedVehicles),
    batches: seedBatches(),
    conflicts: [],
    processedReceipts: [],
    logs: [
      {
        id: uid(),
        at: nowIso(),
        level: "warn",
        message: "夜间网络中断，调度员改用本地计划 v2 暂存装车批次",
      },
    ],
    lastSyncAt: null,
  };
}

function loadState(): PersistShape {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialState();
  try {
    const parsed = JSON.parse(raw) as PersistShape;
    return { ...initialState(), ...parsed };
  } catch {
    return initialState();
  }
}

export const useDeliveryStore = defineStore("delivery", () => {
  const persisted = loadState();

  const online = ref(persisted.online);
  const localPlan = ref<DeliveryPlan>(persisted.localPlan);
  const serverPlan = ref<DeliveryPlan>(persisted.serverPlan);
  const vehicles = ref<Vehicle[]>(persisted.vehicles);
  const batches = ref<LoadingBatch[]>(persisted.batches);
  const conflicts = ref<ConflictRecord[]>(persisted.conflicts);
  const processedReceipts = ref<string[]>(persisted.processedReceipts);
  const logs = ref<SyncLogEntry[]>(persisted.logs);
  const lastSyncAt = ref<string | null>(persisted.lastSyncAt);

  function persist() {
    const data: PersistShape = {
      online: online.value,
      localPlan: localPlan.value,
      serverPlan: serverPlan.value,
      vehicles: vehicles.value,
      batches: batches.value,
      conflicts: conflicts.value,
      processedReceipts: processedReceipts.value,
      logs: logs.value.slice(0, 80),
      lastSyncAt: lastSyncAt.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function pushLogs(entries: SyncLogEntry[]) {
    logs.value = [...entries.reverse(), ...logs.value].slice(0, 80);
  }

  /** 断网期间调度员修改本地配送单（只动本地缓存版本，不触碰在途/服务器计划） */
  function editLocalTrip(tripNo: string, patch: Partial<{ plate: string; tons: number }>) {
    const trip = localPlan.value.trips.find((item) => item.tripNo === tripNo);
    if (!trip) return;
    if (online.value) return;
    if (trip.status === "departed" || trip.status === "arrived") return;
    Object.assign(trip, patch);
    pushLogs([
      {
        id: uid(),
        at: nowIso(),
        level: "info",
        message: `离线修改本地配送单 ${tripNo}：${patch.plate ? `车牌→${patch.plate} ` : ""}${patch.tons !== undefined ? `吨数→${patch.tons}t` : ""}（仅本地 v${localPlan.value.version}）`,
      },
    ]);
    persist();
  }

  /** 离线装车：按车次暂存一个批次 */
  function stageBatch(input: { tripNo: string; plate: string; tons: number }) {
    if (online.value) {
      return { ok: false as const, message: "当前在线，装车请直接走同步合并流程" };
    }
    const receipt = `RCPT-LOCAL-${String(Date.now()).slice(-6)}`;
    const batch: LoadingBatch = {
      id: uid(),
      tripNo: input.tripNo,
      plate: input.plate,
      tons: input.tons,
      baseVersion: localPlan.value.version,
      loadedAt: nowIso(),
      receipt,
      status: "staged",
      timesSent: 0,
    };
    batches.value = [...batches.value, batch];
    pushLogs([
      {
        id: uid(),
        at: nowIso(),
        level: "info",
        message: `离线装车暂存：车次 ${input.tripNo}，${input.plate}，${input.tons}t，回执 ${receipt}`,
      },
    ]);
    persist();
    return { ok: true as const, receipt };
  }

  /**
   * 网络恢复同步：以服务器最新计划为准，按“计划版本 + 车牌”合并暂存批次，
   * 同回执幂等，冲突进台账。
   */
  function syncNow() {
    if (!online.value) {
      return { ok: false as const, message: "网络仍未恢复，无法同步" };
    }
    const result = runSync({
      plan: serverPlan.value,
      vehicles: vehicles.value,
      batches: batches.value,
      conflicts: conflicts.value,
      processedReceipts: processedReceipts.value,
      now: nowIso,
      idGen: uid,
    });
    serverPlan.value = result.plan;
    batches.value = result.batches;
    conflicts.value = result.conflicts;
    processedReceipts.value = result.processedReceipts;
    pushLogs(result.logs);
    lastSyncAt.value = nowIso();
    persist();
    return {
      ok: true as const,
      merged: result.mergedBatchIds.length,
    };
  }

  function setOnline(value: boolean) {
    if (online.value === value) return;
    online.value = value;
    if (value) {
      pushLogs([
        { id: uid(), at: nowIso(), level: "info", message: "网络恢复，开始按最新计划合并离线批次…" },
      ]);
      persist();
      const result = syncNow();
      return result;
    }
    pushLogs([
      { id: uid(), at: nowIso(), level: "warn", message: "网络中断，切换为离线暂存模式" },
    ]);
    persist();
    return { ok: false as const, message: "已离线" };
  }

  /** 冲突处理：改派/减量后按最新计划重算，或作废本地批次 */
  function handleConflict(
    conflictId: string,
    action: "reassign" | "reduce" | "void",
    options: { plate?: string; tons?: number; note?: string },
  ) {
    const result = resolveConflict({
      conflictId,
      action,
      plate: options.plate,
      tons: options.tons,
      note: options.note,
      plan: serverPlan.value,
      vehicles: vehicles.value,
      batches: batches.value,
      conflicts: conflicts.value,
      now: nowIso,
      idGen: uid,
    });
    serverPlan.value = result.plan;
    batches.value = result.batches;
    conflicts.value = result.conflicts;
    pushLogs(result.logs);
    persist();
  }

  /** 确认发车：最后闸门，仍冲突则退回台账，绝不覆盖在途计划 */
  function depart(batchId: string): string | null {
    const result = confirmDeparture({
      batchId,
      plan: serverPlan.value,
      vehicles: vehicles.value,
      batches: batches.value,
      now: nowIso,
      idGen: uid,
    });
    serverPlan.value = result.plan;
    batches.value = result.batches;
    if (result.error) {
      // 退回冲突台账
      const batch = result.batches.find((item) => item.id === batchId);
      if (batch && batch.status === "conflict") {
        const evalResult = evaluateBatch(batch, result.plan, vehicles.value);
        const exists = conflicts.value.some(
          (conflict) => conflict.batchId === batchId && conflict.status === "open",
        );
        if (!exists && evalResult.reasons.length > 0) {
          conflicts.value = [
            ...conflicts.value,
            {
              id: uid(),
              batchId,
              receipt: batch.receipt,
              tripNo: batch.tripNo,
              requestedPlate: batch.plate,
              currentPlate: evalResult.trip?.plate,
              batchTons: batch.tons,
              capacityTons: evalResult.vehicle?.capacityTons,
              reasons: evalResult.reasons,
              status: "open",
              createdAt: nowIso(),
              note: "发车前最新计划校验失败，自动退回",
            },
          ];
        }
      }
      pushLogs([{ id: uid(), at: nowIso(), level: "error", message: `发车被阻止：${result.error}` }]);
    } else {
      const batch = result.batches.find((item) => item.id === batchId);
      pushLogs([
        {
          id: uid(),
          at: nowIso(),
          level: "info",
          message: `车次 ${batch?.tripNo} 已确认发车（回执 ${batch?.receipt}），计划进入在途`,
        },
      ]);
    }
    persist();
    return result.error;
  }

  /**
   * 演示用：模拟“另一名调度员”在服务器端改派一个待发车车次，计划版本 +1。
   */
  function simulateReassign(tripNo: string, newPlate: string) {
    const trip = serverPlan.value.trips.find((item) => item.tripNo === tripNo);
    if (!trip || trip.status !== "planned") {
      return { ok: false as const, message: "只有待发车车次能被改派" };
    }
    const oldPlate = trip.plate;
    serverPlan.value = {
      version: serverPlan.value.version + 1,
      trips: serverPlan.value.trips.map((item) =>
        item.tripNo === tripNo
          ? { ...item, plate: newPlate, updatedBy: "夜班调度员-王磊" }
          : item,
      ),
    };
    pushLogs([
      {
        id: uid(),
        at: nowIso(),
        level: "warn",
        message: `另一名调度员将 ${tripNo} 由 ${oldPlate} 改派为 ${newPlate}，计划升级到 v${serverPlan.value.version}`,
      },
    ]);
    persist();
    return { ok: true as const };
  }

  function resetDemo() {
    const state = initialState();
    online.value = state.online;
    localPlan.value = state.localPlan;
    serverPlan.value = state.serverPlan;
    vehicles.value = state.vehicles;
    batches.value = state.batches;
    conflicts.value = state.conflicts;
    processedReceipts.value = state.processedReceipts;
    logs.value = state.logs;
    lastSyncAt.value = state.lastSyncAt;
    persist();
  }

  const stagedCount = computed(() => batches.value.filter((b) => b.status === "staged").length);
  const openConflictCount = computed(() => conflicts.value.filter((c) => c.status === "open").length);
  const departedCount = computed(() => batches.value.filter((b) => b.status === "departed").length);
  const planVersion = computed(() => serverPlan.value.version);

  return {
    // state
    online,
    localPlan,
    serverPlan,
    vehicles,
    batches,
    conflicts,
    processedReceipts,
    logs,
    lastSyncAt,
    // getters
    stagedCount,
    openConflictCount,
    departedCount,
    planVersion,
    // actions
    editLocalTrip,
    stageBatch,
    syncNow,
    setOnline,
    handleConflict,
    depart,
    simulateReassign,
    resetDemo,
  };
});
