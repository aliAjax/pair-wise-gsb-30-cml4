import type { DeliveryPlan, LoadingBatch, Vehicle } from "./types";

export const STORAGE_KEY = "hxwlfront-19-oil-sync-v1";

export const vehicles: Vehicle[] = [
  { plate: "鲁A·1001", capacityTons: 20 },
  { plate: "鲁A·1002", capacityTons: 25 },
  { plate: "鲁A·1003", capacityTons: 15 },
  { plate: "鲁A·1004", capacityTons: 30 },
  { plate: "鲁A·1005", capacityTons: 20 },
];

/**
 * 本地调度员夜间离线时缓存的计划版本 v2。
 * 司机装车、调度员改配送单都基于这个版本暂存。
 */
export const localPlanV2: DeliveryPlan = {
  version: 2,
  trips: [
    { tripNo: "T1001", station: "城东站", fuel: "92号汽油", tons: 18, plate: "鲁A·1001", arriveAt: "2026-10-05", status: "planned" },
    { tripNo: "T1002", station: "机场站", fuel: "柴油", tons: 22, plate: "鲁A·1002", arriveAt: "2026-10-05", status: "planned" },
    { tripNo: "T1003", station: "新区站", fuel: "95号汽油", tons: 14, plate: "鲁A·1003", arriveAt: "2026-10-05", status: "planned" },
    { tripNo: "T1004", station: "城东站", fuel: "柴油", tons: 10, plate: "鲁A·1004", arriveAt: "2026-10-05", status: "planned" },
    { tripNo: "T1006", station: "机场站", fuel: "92号汽油", tons: 16, plate: "鲁A·1002", arriveAt: "2026-10-06", status: "planned" },
  ],
};

/**
 * 网络恢复后服务器上的最新计划 v3（夜班里另一名调度员已经改过派）。
 */
export const serverPlanV3: DeliveryPlan = {
  version: 3,
  trips: [
    // T1001：本地装 18t 仍在容量内，车牌未变 → 可直接合并
    { tripNo: "T1001", station: "城东站", fuel: "92号汽油", tons: 18, plate: "鲁A·1001", arriveAt: "2026-10-05", status: "planned" },
    // T1002：被夜班调度员改派给鲁A·1005（容量 20），且本地装了 24t → 改派 + 超容量
    { tripNo: "T1002", station: "机场站", fuel: "柴油", tons: 20, plate: "鲁A·1005", arriveAt: "2026-10-05", status: "planned", updatedBy: "夜班调度员-王磊" },
    // T1003：已被确认发车在途，本地旧车次不能覆盖
    { tripNo: "T1003", station: "新区站", fuel: "95号汽油", tons: 14, plate: "鲁A·1003", arriveAt: "2026-10-05", status: "departed", updatedBy: "夜班调度员-王磊", departureReceipt: "RCPT-ONLINE-0003" },
    // T1004：被改派给鲁A·1004 → 实际改成鲁A·1005？这里保留另一辆车
    { tripNo: "T1004", station: "城东站", fuel: "柴油", tons: 10, plate: "鲁A·1002", arriveAt: "2026-10-05", status: "planned", updatedBy: "夜班调度员-王磊" },
    // T1006：最新计划已取消该车次 → trip_missing
  ],
};

/**
 * 夜间离线期间按车次暂存的装车批次。
 */
export function seedBatches(): LoadingBatch[] {
  return [
    {
      id: "seed-batch-1",
      tripNo: "T1001",
      plate: "鲁A·1001",
      tons: 18,
      baseVersion: 2,
      loadedAt: "2026-10-04T22:10:00.000Z",
      receipt: "RCPT-LOCAL-0001",
      status: "staged",
      timesSent: 0,
    },
    {
      id: "seed-batch-2",
      tripNo: "T1002",
      plate: "鲁A·1002",
      tons: 24,
      baseVersion: 2,
      loadedAt: "2026-10-04T22:40:00.000Z",
      receipt: "RCPT-LOCAL-0002",
      status: "staged",
      timesSent: 0,
    },
    {
      id: "seed-batch-3",
      tripNo: "T1003",
      plate: "鲁A·1003",
      tons: 14,
      baseVersion: 2,
      loadedAt: "2026-10-04T23:05:00.000Z",
      receipt: "RCPT-LOCAL-0003",
      status: "staged",
      timesSent: 0,
    },
    {
      id: "seed-batch-4",
      tripNo: "T1004",
      plate: "鲁A·1004",
      tons: 10,
      baseVersion: 2,
      loadedAt: "2026-10-04T23:30:00.000Z",
      receipt: "RCPT-LOCAL-0004",
      status: "staged",
      timesSent: 0,
    },
    {
      id: "seed-batch-5",
      tripNo: "T1006",
      plate: "鲁A·1002",
      tons: 16,
      baseVersion: 2,
      loadedAt: "2026-10-05T00:05:00.000Z",
      receipt: "RCPT-LOCAL-0006",
      status: "staged",
      timesSent: 0,
    },
    {
      // 恢复后旧车次又被发了一遍：回执与 T1001 相同，幂等跳过
      id: "seed-batch-6",
      tripNo: "T1001",
      plate: "鲁A·1001",
      tons: 18,
      baseVersion: 2,
      loadedAt: "2026-10-05T00:40:00.000Z",
      receipt: "RCPT-LOCAL-0001",
      status: "staged",
      timesSent: 0,
    },
  ];
}
