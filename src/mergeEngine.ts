// 离线批次恢复后的合并引擎（纯函数，不直接读写状态）
import type {
  ConflictEntry,
  ConflictReason,
  DeliveryPlan,
  LoadingBatch,
  SyncLog,
  Vehicle
} from "./types";

export interface MergeContext {
  plans: DeliveryPlan[];
  vehicles: Vehicle[];
  /** 已处理过的回执号集合（幂等表） */
  processedReceipts: Set<string>;
  /** 当前执行同步的调度员 */
  operator: string;
  now: string;
  /**
   * 重算模式：调度员已在冲突台账核对最新计划并显式处理过批次，
   * 此时跳过版本差异比对，只校验在途、车辆存在与容量；
   * 车辆改派差异仅在调度员显式换车（plateAdjusted）时才放行。
   */
  rebaseMode?: boolean;
  /** 调度员是否已在台账中显式调整过批次车牌 */
  plateAdjusted?: boolean;
}

export interface MergeOutcome {
  plans: DeliveryPlan[];
  conflicts: ConflictEntry[];
  logs: SyncLog[];
  /** 本次新处理的回执号 */
  processedReceipts: Set<string>;
  /** 各批次的处理结果，批次 id -> 状态（同回执多条时各自保留结果） */
  batchResults: Map<string, { status: LoadingBatch["status"]; note: string }>;
}

function findPlan(plans: DeliveryPlan[], code: string) {
  return plans.find((p) => p.code === planCodeKey(code));
}

/** 车次编号统一比较键（去空格、大写） */
function planCodeKey(code: string) {
  return code.trim().toUpperCase();
}

function detectConflict(
  batch: LoadingBatch,
  plan: DeliveryPlan | undefined,
  vehicle: Vehicle | undefined,
  ctx: MergeContext
): ConflictReason[] {
  const reasons: ConflictReason[] = [];

  if (!plan) {
    reasons.push("计划不存在");
    return reasons;
  }
  if (!vehicle) {
    reasons.push("车辆不存在");
  }

  // 在途计划不可覆盖、不可确认发车
  if (plan.status === "运输中" || plan.status === "已到站") {
    reasons.push("计划已在途");
  }

  if (!ctx.rebaseMode) {
    // 计划版本与装车时快照不一致 -> 期间有调度员改过
    if (plan.version !== batch.snapshotVersion) {
      // 车牌被另一名调度员改派（改派到别的车）
      if (plan.plate && plan.plate !== batch.plate) {
        reasons.push("车辆已改派");
      } else {
        reasons.push("计划版本过期");
      }
    } else if (plan.plate && plan.plate !== batch.plate) {
      // 同版本但车牌不一致（本地单与线上派车不符），同样视为改派
      reasons.push("车辆已改派");
    }
  } else if (!ctx.plateAdjusted && plan.plate && plan.plate !== batch.plate) {
    // 重算时版本差异已由调度员核对；但改派差异必须显式换车处理，不能一键覆盖同事的改派
    reasons.push("车辆已改派");
  }

  // 吨数超容量：按批次车牌对应的车辆容量判断
  if (vehicle && batch.tons > vehicle.capacity) {
    reasons.push("吨数超容量");
  }

  return reasons;
}

type BatchResult = { status: LoadingBatch["status"]; note: string };

/**
 * 依次处理恢复后的离线批次。
 * 规则：
 * 1. 同一回执只处理一次（processedReceipts 幂等表 + 本批去重）。
 * 2. 无冲突 -> 按最新计划合并：以批次车牌/吨数更新计划，version+1，并可确认发车。
 * 3. 有冲突 -> 批次保留到冲突台账，不覆盖在途计划、不确认发车。
 */
export function mergeBatches(
  batches: LoadingBatch[],
  ctx: MergeContext
): MergeOutcome {
  const plans = ctx.plans.map((p) => ({ ...p }));
  const conflicts: ConflictEntry[] = [];
  const logs: SyncLog[] = [];
  const processed = new Set<string>(ctx.processedReceipts);
  const batchResults = new Map<string, BatchResult>();
  // 本次同步内的回执去重，防止同一批数据重复处理
  const seenThisRun = new Set<string>();

  for (const batch of batches) {
    const receipt = batch.receiptId.trim();

    // 幂等：历史已处理
    if (processed.has(receipt)) {
      batchResults.set(batch.id, {
        status: "重复跳过",
        note: `回执 ${receipt} 此前已处理，跳过`
      });
      logs.push({
        id: crypto.randomUUID(),
        at: ctx.now,
        receiptId: receipt,
        planCode: batch.planCode,
        result: "重复跳过",
        detail: "回执已在幂等表中，未重复发车"
      });
      continue;
    }
    // 幂等：本次同步内重复（恢复后旧车次被又发一遍的典型场景）
    if (seenThisRun.has(receipt)) {
      batchResults.set(batch.id, {
        status: "重复跳过",
        note: `回执 ${receipt} 在本次同步中重复出现，跳过`
      });
      logs.push({
        id: crypto.randomUUID(),
        at: ctx.now,
        receiptId: receipt,
        planCode: batch.planCode,
        result: "重复跳过",
        detail: "同一回执在待同步列表中重复，仅处理一次"
      });
      continue;
    }
    seenThisRun.add(receipt);

    const plan = findPlan(plans, batch.planCode);
    const vehicle = ctx.vehicles.find((v) => v.plate === batch.plate.trim());
    const reasons = detectConflict(batch, plan, vehicle, ctx);

    if (reasons.length > 0) {
      // 冲突挂起：保留到冲突台账，不动在途计划，不确认发车
      conflicts.push({
        id: crypto.randomUUID(),
        receiptId: receipt,
        planCode: batch.planCode,
        plate: batch.plate,
        batchTons: batch.tons,
        snapshotVersion: batch.snapshotVersion,
        reasons,
        status: "未决",
        detectedAt: ctx.now
      });
      processed.add(receipt);
      batchResults.set(batch.id, {
        status: "冲突挂起",
        note: `冲突：${reasons.join("、")}，已挂起到冲突台账`
      });
      logs.push({
        id: crypto.randomUUID(),
        at: ctx.now,
        receiptId: receipt,
        planCode: batch.planCode,
        result: "冲突挂起",
        detail: reasons.join("、")
      });
      continue;
    }

    // 无冲突：按最新计划合并。计划一定存在（无 计划不存在 冲突）
    const target = plan!;
    const versionFrom = target.version;
    target.plate = batch.plate.trim();
    target.tons = batch.tons;
    target.version += 1;
    target.updatedBy = ctx.operator;
    target.updatedAt = ctx.now;
    target.status = "运输中"; // 合并即确认发车（待发车 -> 运输中）
    target.notes = `离线装车回执 ${receipt} 合并：v${versionFrom} → v${target.version}`;

    processed.add(receipt);
    batchResults.set(batch.id, {
      status: "已合并",
      note: `已合并到 ${target.code}，计划升至 v${target.version}，确认发车`
    });
    logs.push({
      id: crypto.randomUUID(),
      at: ctx.now,
      receiptId: receipt,
      planCode: target.code,
      result: "合并",
      detail: `车牌 ${target.plate}，${batch.tons} 吨，v${versionFrom} → v${target.version}，已确认发车`
    });
  }

  return { plans, conflicts, logs, processedReceipts: processed, batchResults };
}

/**
 * 冲突处理后按最新计划重算：
 * 调度员已在台账中核对最新计划，先把批次的版本快照重定基线到当前版本，
 * 再重新比对在途状态/车辆/容量（版本与车牌差异视为调度员已显式接受）：
 * - 无冲突（已释放车牌、扩容车辆、批次换车或吨数已修正）-> 正常合并并确认发车
 * - 仍有冲突 -> 保持挂起，更新冲突原因
 */
export function recomputeAfterResolution(
  batch: LoadingBatch,
  plans: DeliveryPlan[],
  vehicles: Vehicle[],
  operator: string,
  now: string
): { merged: boolean; reasons: ConflictReason[]; plans: DeliveryPlan[] } {
  const nextPlans = plans.map((p) => ({ ...p }));
  const plan = findPlan(nextPlans, batch.planCode);
  const vehicle = vehicles.find((v) => v.plate === batch.plate.trim());

  if (!plan) {
    return { merged: false, reasons: ["计划不存在"], plans };
  }

  const reasons = detectConflict(batch, plan, vehicle, {
    plans: nextPlans,
    vehicles,
    processedReceipts: new Set(),
    operator,
    now,
    rebaseMode: true,
    plateAdjusted: batch.dispatcherAdjusted === true
  });

  if (reasons.length > 0) {
    return { merged: false, reasons, plans };
  }

  const versionFrom = plan.version;
  plan.plate = batch.plate.trim();
  plan.tons = batch.tons;
  plan.version += 1;
  plan.updatedBy = operator;
  plan.updatedAt = now;
  plan.status = "运输中";
  plan.notes = `冲突处理后重算合并，回执 ${batch.receiptId}：v${versionFrom} → v${plan.version}`;
  return { merged: true, reasons: [], plans: nextPlans };
}
