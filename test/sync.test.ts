// 核心同步逻辑自测：幂等、改派/超容量/在途/车次缺失冲突、冲突重算、发车闸门
import assert from "node:assert";
import type { DeliveryPlan, LoadingBatch, Vehicle } from "../src/types";
import { confirmDeparture, resolveConflict, runSync } from "../src/lib/sync";

let counter = 0;
const idGen = () => `id-${++counter}`;
let tick = 0;
const now = () => `2026-10-05T0${Math.floor(tick / 60)}:${String(tick++ % 60).padStart(2, "0")}:00.000Z`;

const vehicles: Vehicle[] = [
  { plate: "A1", capacityTons: 20 },
  { plate: "A2", capacityTons: 25 },
  { plate: "A3", capacityTons: 15 },
];

function makePlan(overrides: Partial<DeliveryPlan["trips"][number]> = {} as never): DeliveryPlan {
  return {
    version: 3,
    trips: [
      { tripNo: "T1", station: "s", fuel: "f", tons: 18, plate: "A1", arriveAt: "d", status: "planned" },
      { tripNo: "T2", station: "s", fuel: "f", tons: 20, plate: "A2", arriveAt: "d", status: "planned" },
      { tripNo: "T3", station: "s", fuel: "f", tons: 14, plate: "A3", arriveAt: "d", status: "planned" },
    ].map((t) => ({ ...t, ...(overrides as object) })) as DeliveryPlan["trips"],
  };
}

function makePlanV3(): DeliveryPlan {
  return {
    version: 3,
    trips: [
      { tripNo: "T1", station: "s", fuel: "f", tons: 18, plate: "A1", arriveAt: "d", status: "planned" },
      // T2 被另一名调度员改派给 A3（容量 15）
      { tripNo: "T2", station: "s", fuel: "f", tons: 14, plate: "A3", arriveAt: "d", status: "planned", updatedBy: "other" },
      // T3 已在途
      { tripNo: "T3", station: "s", fuel: "f", tons: 14, plate: "A3", arriveAt: "d", status: "departed", departureReceipt: "R-ONLINE" },
    ],
  };
}

function batch(partial: Partial<LoadingBatch>): LoadingBatch {
  return {
    id: idGen(),
    tripNo: "T1",
    plate: "A1",
    tons: 18,
    baseVersion: 2,
    loadedAt: now(),
    receipt: `R-${counter}`,
    status: "staged",
    timesSent: 0,
    ...partial,
  };
}

function sync(
  plan: DeliveryPlan,
  batches: LoadingBatch[],
  processedReceipts: string[] = [],
  conflicts = [],
) {
  return runSync({ plan, vehicles, batches, conflicts, processedReceipts, now, idGen });
}

// 1. 干净合并：车牌一致、吨数合规
{
  const plan = makePlan();
  const b = batch({ tripNo: "T1", plate: "A1", tons: 19, receipt: "R1" });
  const r = sync(plan, [b]);
  assert.equal(r.batches[0].status, "merged");
  assert.equal(r.plan.trips[0].tons, 19, "实装吨数回填到最新计划行");
  assert.deepEqual(r.processedReceipts, ["R1"]);
  assert.equal(r.plan.version, 3, "同步不改动计划版本");
  assert.equal(r.plan.trips[2].status, "planned");
  console.log("✓ 无冲突批次按版本+车牌合并，吨数回填，计划版本不变");
}

// 2. 改派冲突：本地批次保留进台账，计划不被覆盖，不能发车
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T2", plate: "A2", tons: 14, receipt: "R2" });
  const r = sync(plan, [b]);
  assert.equal(r.batches[0].status, "conflict");
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].reasons, ["reassigned"]);
  assert.equal(r.conflicts[0].currentPlate, "A3");
  assert.equal(r.plan.trips[1].plate, "A3", "在计划不得被本地车牌覆盖");
  assert.equal(r.plan.trips[1].tons, 14);
  assert.ok(r.processedReceipts.includes("R2"), "冲突回执也登记，防止旧车次再发");
  const dep = confirmDeparture({ batchId: b.id, plan: r.plan, vehicles, batches: r.batches });
  assert.ok(dep.error, "冲突批次不能确认发车");
  console.log("✓ 车辆被改派 → 进冲突台账，不覆盖在途/最新计划，禁止发车");
}

// 3. 超容量冲突
{
  const plan = makePlan();
  const b = batch({ tripNo: "T1", plate: "A1", tons: 22, receipt: "R3" }); // 容量 20
  const r = sync(plan, [b]);
  assert.equal(r.batches[0].status, "conflict");
  assert.deepEqual(r.conflicts[0].reasons, ["over_capacity"]);
  console.log("✓ 吨数超车辆容量 → 冲突台账");
}

// 4. 在途冲突：不得覆盖在途计划
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T3", plate: "A3", tons: 14, receipt: "R4" });
  const r = sync(plan, [b]);
  assert.deepEqual(r.conflicts[0].reasons, ["in_transit"]);
  assert.equal(r.plan.trips[2].departureReceipt, "R-ONLINE", "在途回执不被覆盖");
  assert.equal(r.plan.trips[2].status, "departed");
  console.log("✓ 车次已在途 → 本地批次保留台账，在途计划不被覆盖");
}

// 5. 车次已取消/缺失
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T9", plate: "A1", tons: 5, receipt: "R5" });
  const r = sync(plan, [b]);
  assert.deepEqual(r.conflicts[0].reasons, ["trip_missing"]);
  console.log("✓ 最新计划中车次已取消 → trip_missing 冲突");
}

// 6. 同回执幂等：历史已处理 + 同批次重复，均只处理一次
{
  const plan = makePlan();
  const first = batch({ tripNo: "T1", plate: "A1", tons: 18, receipt: "DUP", loadedAt: "2026-10-05T00:00:00.000Z" });
  const again = batch({ tripNo: "T1", plate: "A1", tons: 18, receipt: "DUP", loadedAt: "2026-10-05T01:00:00.000Z" });
  const r = sync(plan, [first, again]);
  assert.equal(r.batches.find((x) => x.id === first.id)?.status, "merged");
  assert.equal(r.batches.find((x) => x.id === again.id)?.status, "duplicate");
  assert.equal(r.plan.trips[0].tons, 18);
  assert.equal(r.processedReceipts.filter((x) => x === "DUP").length, 1);

  // 再同步一轮（模拟恢复后旧车次又发一遍）
  const r2 = sync(r.plan, r.batches, r.processedReceipts, r.conflicts);
  assert.equal(r2.batches.find((x) => x.id === again.id)?.status, "duplicate");
  assert.equal(r2.mergedBatchIds.length, 0, "第二次同步无新合并");
  console.log("✓ 同一回执只处理一次：恢复后重发旧车次被幂等跳过");
}

// 7. 冲突处理-跟随改派并重算成功
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T2", plate: "A2", tons: 14, receipt: "R7" });
  const synced = sync(plan, [b]);
  const conflict = synced.conflicts[0];
  const resolved = resolveConflict({
    conflictId: conflict.id,
    action: "reassign",
    plate: "A3", // 跟随最新计划车牌（容量 15，14t 合规）
    plan: synced.plan,
    vehicles,
    batches: synced.batches,
    conflicts: synced.conflicts,
    now,
    idGen,
  });
  assert.equal(resolved.batches.find((x) => x.id === b.id)?.status, "merged");
  assert.equal(resolved.conflicts[0].status, "resolved");
  assert.equal(resolved.conflicts[0].resolution, "reassign");
  console.log("✓ 冲突处理：跟随最新车牌改派 → 按最新计划重算合并");
}

// 8. 冲突处理-减量仍超容量 → 台账保持开启
{
  const plan = makePlanV3(); // T2 最新车牌 A3 容量 15
  const b = batch({ tripNo: "T2", plate: "A2", tons: 25, receipt: "R8" });
  const synced = sync(plan, [b]);
  const conflict = synced.conflicts[0];
  const resolved = resolveConflict({
    conflictId: conflict.id,
    action: "reduce",
    tons: 18, // A3 只有 15，仍超
    plan: synced.plan,
    vehicles,
    batches: synced.batches,
    conflicts: synced.conflicts,
    now,
    idGen,
  });
  assert.equal(resolved.conflicts[0].status, "open", "仍冲突，台账重新打开");
  assert.equal(resolved.batches[0].status, "conflict");

  // 再减到 14，重算合并
  const resolved2 = resolveConflict({
    conflictId: conflict.id,
    action: "reduce",
    tons: 14,
    plan: resolved.plan,
    vehicles,
    batches: resolved.batches,
    conflicts: resolved.conflicts,
    now,
    idGen,
  });
  assert.equal(resolved2.batches[0].status, "merged");
  assert.equal(resolved2.conflicts[0].status, "resolved");
  console.log("✓ 减量后仍超容量继续留在台账；减到容量内才重算合并");
}

// 9. 作废本地批次：冲突关闭，计划不动
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T3", plate: "A3", tons: 14, receipt: "R9" });
  const synced = sync(plan, [b]);
  const resolved = resolveConflict({
    conflictId: synced.conflicts[0].id,
    action: "void",
    note: "以在途计划为准",
    plan: synced.plan,
    vehicles,
    batches: synced.batches,
    conflicts: synced.conflicts,
    now,
    idGen,
  });
  assert.equal(resolved.batches[0].status, "voided");
  assert.equal(resolved.conflicts[0].status, "resolved");
  assert.equal(resolved.plan.trips[2].status, "departed");
  console.log("✓ 作废本地批次：冲突关闭，在途计划不受影响");
}

// 10. 确认发车闸门：合并后若计划又被改派，发车被阻止
{
  const plan = makePlanV3();
  const b = batch({ tripNo: "T1", plate: "A1", tons: 18, receipt: "R10" });
  const synced = sync(plan, [b]);
  assert.equal(synced.batches[0].status, "merged");

  // 另一名调度员趁处理冲突时把 T1 改派给 A3
  const changedPlan: DeliveryPlan = {
    version: 4,
    trips: synced.plan.trips.map((t) => (t.tripNo === "T1" ? { ...t, plate: "A3" } : t)),
  };
  const dep = confirmDeparture({ batchId: b.id, plan: changedPlan, vehicles, batches: synced.batches });
  assert.ok(dep.error, "发车瞬间校验失败应阻止");
  assert.equal(dep.batches[0].status, "conflict", "批次退回冲突状态");
  assert.equal(changedPlan.trips[0].status, "planned", "计划没有被误发车");

  // 正常发车
  const depOk = confirmDeparture({ batchId: b.id, plan: synced.plan, vehicles, batches: synced.batches });
  assert.equal(depOk.error, null);
  assert.equal(depOk.batches[0].status, "departed");
  assert.equal(depOk.plan.trips[0].status, "departed");
  assert.equal(depOk.plan.trips[0].departureReceipt, "R10");

  // 同回执不能重复发车
  const depAgain = confirmDeparture({ batchId: b.id, plan: depOk.plan, vehicles, batches: depOk.batches });
  assert.ok(depAgain.error, "已发车回执不得重复确认");
  console.log("✓ 发车闸门：计划期间被改派则阻止并退回；成功发车且不可重复发车");
}

// 11. timesSent 统计与非暂存批次不重放
{
  const plan = makePlan();
  const b = batch({ tripNo: "T1", plate: "A1", tons: 18, receipt: "R11" });
  const r1 = sync(plan, [b]);
  assert.equal(r1.batches[0].timesSent, 1);
  const r2 = sync(r1.plan, r1.batches, r1.processedReceipts, r1.conflicts);
  assert.equal(r2.batches[0].timesSent, 1, "merged 批次不会被再次同步");
  console.log("✓ 仅暂存批次参与同步，已合并批次不重放");
}

console.log("\n全部 11 项核心逻辑自测通过 ✅");
