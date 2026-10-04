import type {
  BatchStatus,
  ConflictReason,
  ConflictRecord,
  DeliveryPlan,
  LoadingBatch,
  PlanTrip,
  ResolutionAction,
  SyncInput,
  SyncResult,
  Vehicle,
} from "../types";

export const CONFLICT_LABEL: Record<ConflictReason, string> = {
  reassigned: "车辆已被改派",
  over_capacity: "吨数超容量",
  in_transit: "车次已在途",
  trip_missing: "车次已取消",
  vehicle_unknown: "车辆台账无此车牌",
};

export const REASON_TEXT: Record<ResolutionAction, string> = {
  reassign: "按最新车牌改派",
  reduce: "减量后重算",
  void: "作废本地批次",
};

function defaultNow() {
  return new Date().toISOString();
}

function defaultId() {
  return crypto.randomUUID();
}

interface EvalResult {
  trip?: PlanTrip;
  vehicle?: Vehicle;
  reasons: ConflictReason[];
}

/**
 * 按最新计划与车辆台账评估一个离线批次。
 * 冲突判定顺序：车次不存在 → 在途 → 改派 → 车辆不存在 → 超容量。
 */
export function evaluateBatch(
  batch: LoadingBatch,
  plan: DeliveryPlan,
  vehicles: Vehicle[],
): EvalResult {
  const trip = plan.trips.find((item) => item.tripNo === batch.tripNo);
  if (!trip) {
    return { reasons: ["trip_missing"] };
  }

  const reasons: ConflictReason[] = [];

  // 在途计划不可被本地批次覆盖
  if (trip.status === "departed" || trip.status === "arrived") {
    reasons.push("in_transit");
  }

  // 恢复后按“计划版本 + 车牌”合并：车牌不一致即被他人改派
  const reassigned = trip.plate !== batch.plate;
  if (reassigned) {
    reasons.push("reassigned");
  }

  const localVehicle = vehicles.find((item) => item.plate === batch.plate);
  if (!localVehicle) {
    reasons.push("vehicle_unknown");
  }

  // 容量闸门：本地申报车辆与最新计划改派后的车辆都要装得下
  const planVehicle = vehicles.find((item) => item.plate === trip.plate);
  const overCapacity =
    (localVehicle ? batch.tons > localVehicle.capacityTons : false) ||
    (planVehicle ? batch.tons > planVehicle.capacityTons : false);
  if (overCapacity) {
    reasons.push("over_capacity");
  }

  return { trip, vehicle: localVehicle ?? planVehicle, reasons };
}

function toConflict(
  batch: LoadingBatch,
  evalResult: EvalResult,
  id: string,
  now: string,
): ConflictRecord {
  return {
    id,
    batchId: batch.id,
    receipt: batch.receipt,
    tripNo: batch.tripNo,
    requestedPlate: batch.plate,
    currentPlate: evalResult.trip?.plate,
    batchTons: batch.tons,
    capacityTons: evalResult.vehicle?.capacityTons,
    reasons: evalResult.reasons,
    status: "open",
    createdAt: now,
  };
}

function conflictMessage(reasons: ConflictReason[]): string {
  return reasons.map((reason) => CONFLICT_LABEL[reason]).join("、");
}

/**
 * 网络恢复后的同步入口：
 * 1. 按车次暂存的批次逐条与最新计划合并；
 * 2. 同一回执只处理一次（已处理或本批次内重复均跳过）；
 * 3. 冲突批次原样保留进冲突台账，不覆盖在途计划、不能确认发车；
 * 4. 无冲突的批次按“计划版本 + 车牌”合并到最新计划。
 */
export function runSync(input: SyncInput): SyncResult {
  const now = input.now ?? defaultNow;
  const idGen = input.idGen ?? defaultId;

  const plan: DeliveryPlan = {
    version: input.plan.version,
    trips: input.plan.trips.map((trip) => ({ ...trip })),
  };
  const vehicles = input.vehicles;
  const batches = input.batches.map((batch) => ({ ...batch }));
  const conflicts = input.conflicts.map((conflict) => ({ ...conflict }));
  const processedSet = new Set(input.processedReceipts);

  const logs: SyncResult["logs"] = [];
  const mergedBatchIds: string[] = [];
  let duplicateCount = 0;

  // 只重放仍处于暂存/冲突中未处理的批次；merged/departed/voided 不再处理
  const pending = batches.filter((batch) => batch.status === "staged");
  const ordered = [...pending].sort((a, b) => a.loadedAt.localeCompare(b.loadedAt));

  for (const batch of ordered) {
    batch.timesSent += 1;
    batch.syncedVersion = plan.version;

    // 幂等：同一回执只处理一次（历史台账或本次同步内已处理）
    if (processedSet.has(batch.receipt)) {
      batch.status = "duplicate";
      batch.message = `回执 ${batch.receipt} 已处理过，按幂等规则跳过，不重复发车`;
      duplicateCount += 1;
      logs.push({
        id: idGen(),
        at: now(),
        level: "warn",
        message: `车次 ${batch.tripNo} 回执 ${batch.receipt} 重复提交，已跳过（第 ${batch.timesSent} 次发送）`,
      });
      continue;
    }

    const evalResult = evaluateBatch(batch, plan, vehicles);

    if (evalResult.reasons.length > 0) {
      // 冲突：本地批次保留进冲突台账，计划原样不动
      batch.status = "conflict";
      batch.message = conflictMessage(evalResult.reasons);
      const exists = conflicts.some(
        (conflict) => conflict.batchId === batch.id && conflict.status === "open",
      );
      if (!exists) {
        conflicts.push(toConflict(batch, evalResult, idGen(), now()));
      }
      processedSet.add(batch.receipt); // 回执仍登记，防止旧车次恢复后被再发一遍
      logs.push({
        id: idGen(),
        at: now(),
        level: "error",
        message: `车次 ${batch.tripNo}（${batch.plate} / ${batch.tons}吨）合并冲突：${conflictMessage(evalResult.reasons)}，已转入冲突台账`,
      });
      continue;
    }

    // 无冲突：按计划版本 + 车牌合并（以最新计划为准，回填实际装车吨数）
    const trip = plan.trips.find((item) => item.tripNo === batch.tripNo)!;
    trip.tons = batch.tons;
    batch.status = "merged";
    batch.message = `已按计划 v${plan.version} 合并到 ${batch.plate}，可确认发车`;
    mergedBatchIds.push(batch.id);
    processedSet.add(batch.receipt);
    logs.push({
      id: idGen(),
      at: now(),
      level: "info",
      message: `车次 ${batch.tripNo} 装车 ${batch.tons} 吨已合并到计划 v${plan.version}（${batch.plate}）`,
    });
  }

  const conflictCount = batches.filter((batch) => batch.status === "conflict").length;
  logs.unshift({
    id: idGen(),
    at: now(),
    level: "info",
    message: `同步完成：合并 ${mergedBatchIds.length} 车，冲突 ${conflictCount} 车，重复回执 ${duplicateCount} 条（计划保持 v${plan.version}）`,
  });

  return {
    plan,
    batches,
    conflicts,
    processedReceipts: [...processedSet],
    mergedBatchIds,
    logs,
  };
}

export interface ResolutionInput {
  conflictId: string;
  action: ResolutionAction;
  /** 改派目标车牌 */
  plate?: string;
  /** 减量后的吨数 */
  tons?: number;
  note?: string;
  plan: DeliveryPlan;
  vehicles: Vehicle[];
  batches: LoadingBatch[];
  conflicts: ConflictRecord[];
  now?: () => string;
  idGen?: () => string;
}

export interface ResolutionResult {
  plan: DeliveryPlan;
  batches: LoadingBatch[];
  conflicts: ConflictRecord[];
  logs: SyncResult["logs"];
}

/**
 * 处理完冲突后按最新计划重算：
 * - reassign：本地批次改用最新车牌重新评估；
 * - reduce：降到容量内后重新评估；
 * - void：作废本地批次，冲突关闭。
 * 重算无冲突即合并；仍有冲突则冲突台账保持开启（吨数/车牌信息刷新）。
 */
export function resolveConflict(input: ResolutionInput): ResolutionResult {
  const now = input.now ?? defaultNow;
  const idGen = input.idGen ?? defaultId;

  const conflict = input.conflicts.find((item) => item.id === input.conflictId);
  const logs: SyncResult["logs"] = [];
  if (!conflict || conflict.status === "resolved") {
    return {
      plan: input.plan,
      batches: input.batches,
      conflicts: input.conflicts,
      logs,
    };
  }

  const plan: DeliveryPlan = {
    version: input.plan.version,
    trips: input.plan.trips.map((trip) => ({ ...trip })),
  };
  const batches = input.batches.map((batch) => ({ ...batch }));
  const conflicts = input.conflicts.map((item) => ({ ...item }));
  const target = conflicts.find((item) => item.id === input.conflictId)!;
  const batch = batches.find((item) => item.id === target.batchId);

  if (!batch) {
    return { plan, batches, conflicts, logs };
  }

  target.status = "resolved";
  target.resolvedAt = now();
  target.resolution = input.action;
  target.note = input.note;

  if (input.action === "void") {
    batch.status = "voided";
    batch.message = "冲突处理：本地批次作废，以在途/最新计划为准";
    logs.push({
      id: idGen(),
      at: now(),
      level: "warn",
      message: `车次 ${batch.tripNo} 本地批次已作废（回执 ${batch.receipt}）`,
    });
    return { plan, batches, conflicts, logs };
  }

  // 按调度员的处理动作修正本地批次，再按最新计划重算
  if (input.action === "reassign" && input.plate) {
    batch.plate = input.plate;
    target.resolvedPlate = input.plate;
  }
  if (input.action === "reduce" && typeof input.tons === "number") {
    batch.tons = input.tons;
    target.resolvedTons = input.tons;
    // 减量重算以“车能装下且跟得上最新计划”为前提：车牌同时对齐最新计划
    const latestTrip = plan.trips.find((item) => item.tripNo === batch.tripNo);
    if (latestTrip) {
      batch.plate = latestTrip.plate;
      target.resolvedPlate = latestTrip.plate;
    }
  }

  const evalResult = evaluateBatch(batch, plan, input.vehicles);

  if (evalResult.reasons.length > 0) {
    // 重算仍冲突：重新打开台账（保持本地批次，不覆盖计划）
    target.status = "open";
    target.reasons = evalResult.reasons;
    target.currentPlate = evalResult.trip?.plate;
    target.capacityTons = evalResult.vehicle?.capacityTons;
    target.batchTons = batch.tons;
    target.requestedPlate = batch.plate;
    target.resolvedAt = undefined;
    target.resolution = undefined;
    batch.status = "conflict";
    batch.message = conflictMessage(evalResult.reasons);
    logs.push({
      id: idGen(),
      at: now(),
      level: "error",
      message: `车次 ${batch.tripNo} 重算后仍冲突：${conflictMessage(evalResult.reasons)}`,
    });
    return { plan, batches, conflicts, logs };
  }

  const trip = plan.trips.find((item) => item.tripNo === batch.tripNo)!;
  trip.tons = batch.tons;
  batch.status = "merged";
  batch.message = `冲突已处理，按计划 v${plan.version} 重算合并到 ${batch.plate}`;
  logs.push({
    id: idGen(),
    at: now(),
    level: "info",
    message: `车次 ${batch.tripNo} 冲突已处理（${REASON_TEXT[input.action]}），重算合并到 ${batch.plate}`,
  });
  return { plan, batches, conflicts, logs };
}

export interface DepartureInput {
  batchId: string;
  plan: DeliveryPlan;
  vehicles: Vehicle[];
  batches: LoadingBatch[];
  now?: () => string;
  idGen?: () => string;
}

export interface DepartureResult {
  plan: DeliveryPlan;
  batches: LoadingBatch[];
  /** 返回 null 表示确认成功；否则为阻止原因（同时批次不会变成在途） */
  error: string | null;
}

/**
 * 确认发车前的最后闸门：只允许已合并批次发车，
 * 发车瞬间再按最新计划与容量校验一次，防止处理冲突期间计划又被改派。
 */
export function confirmDeparture(input: DepartureInput): DepartureResult {
  const now = input.now ?? defaultNow;
  const plan: DeliveryPlan = {
    version: input.plan.version,
    trips: input.plan.trips.map((trip) => ({ ...trip })),
  };
  const batches = input.batches.map((batch) => ({ ...batch }));
  const batch = batches.find((item) => item.id === input.batchId);

  if (!batch) {
    return { plan, batches, error: "批次不存在" };
  }
  if (batch.status === "departed") {
    return { plan, batches, error: `回执 ${batch.receipt} 已确认发车，不能重复发车` };
  }
  if (batch.status !== "merged") {
    return {
      plan,
      batches,
      error: `批次当前为「${batch.status}」状态，只有合并成功的批次才能发车`,
    };
  }

  const evalResult = evaluateBatch(batch, plan, input.vehicles);
  if (evalResult.reasons.length > 0) {
    batch.status = "conflict";
    batch.message = conflictMessage(evalResult.reasons);
    return {
      plan,
      batches,
      error: `最新计划校验未通过：${conflictMessage(evalResult.reasons)}，已退回冲突重算`,
    };
  }

  const trip = plan.trips.find((item) => item.tripNo === batch.tripNo)!;
  trip.status = "departed";
  trip.tons = batch.tons;
  trip.departureReceipt = batch.receipt;
  batch.status = "departed";
  batch.message = `已于 ${now()} 确认发车（回执 ${batch.receipt}）`;
  return { plan, batches, error: null };
}

export function batchStatusLabel(status: BatchStatus): string {
  const map: Record<BatchStatus, string> = {
    staged: "离线暂存",
    merged: "已合并待发车",
    conflict: "冲突待处理",
    duplicate: "重复跳过",
    departed: "已发车",
    voided: "已作废",
  };
  return map[status];
}
