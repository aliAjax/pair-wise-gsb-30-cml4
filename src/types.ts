// 离线装车同步领域模型：配送计划版本、车辆容量、离线批次、冲突台账、回执幂等

/** 车次（计划行）状态 */
export type TripStatus = "planned" | "departed" | "arrived" | "cancelled";

/** 车辆 */
export interface Vehicle {
  /** 车牌号，作为车辆主键 */
  plate: string;
  /** 额定容量（吨） */
  capacityTons: number;
}

/** 配送计划中的一个车次 */
export interface PlanTrip {
  /** 车次号，计划内唯一 */
  tripNo: string;
  station: string;
  fuel: string;
  /** 计划吨数 */
  tons: number;
  /** 当前计划版本指定的车牌（可能被另一名调度员改派） */
  plate: string;
  arriveAt: string;
  status: TripStatus;
  /** 最后改派人（用于识别“另一名调度员改派”） */
  updatedBy?: string;
  /** 已确认发车的回执 */
  departureReceipt?: string;
}

/** 配送计划（按版本整体发布） */
export interface DeliveryPlan {
  version: number;
  trips: PlanTrip[];
}

/** 离线装车批次状态 */
export type BatchStatus =
  | "staged" // 离线暂存
  | "merged" // 已与最新计划合并
  | "conflict" // 存在冲突，留在冲突台账
  | "duplicate" // 回执已处理过，跳过
  | "departed" // 已确认发车
  | "voided"; // 冲突处理时作废

export interface LoadingBatch {
  id: string;
  /** 车次号：离线时按车次暂存的依据 */
  tripNo: string;
  /** 车牌：恢复后按“计划版本 + 车牌”合并的依据 */
  plate: string;
  /** 离线装车吨数 */
  tons: number;
  /** 本地依据的计划版本 */
  baseVersion: number;
  /** 装车完成时间 */
  loadedAt: string;
  /** 装车回执号，同一回执只处理一次（幂等键） */
  receipt: string;
  status: BatchStatus;
  /** 已尝试同步的次数（重发不会再处理） */
  timesSent: number;
  /** 最近一次同步针对的最新计划版本 */
  syncedVersion?: number;
  /** 合并/冲突时的说明 */
  message?: string;
}

/** 冲突原因 */
export type ConflictReason =
  | "reassigned" // 车辆已被另一名调度员改派
  | "over_capacity" // 装车吨数超过车辆容量
  | "in_transit" // 车次已在途，本地批次不得覆盖
  | "trip_missing" // 最新计划中该车次已取消/不存在
  | "vehicle_unknown"; // 车牌在车辆台账中不存在

export type ConflictStatus = "open" | "resolved";
export type ResolutionAction = "reassign" | "reduce" | "void";

export interface ConflictRecord {
  id: string;
  batchId: string;
  receipt: string;
  tripNo: string;
  /** 本地批次请求的车牌 */
  requestedPlate: string;
  /** 冲突时最新计划中的车牌（如车次仍存在） */
  currentPlate?: string;
  batchTons: number;
  /** 车辆容量（如车牌存在） */
  capacityTons?: number;
  reasons: ConflictReason[];
  status: ConflictStatus;
  createdAt: string;
  resolvedAt?: string;
  resolution?: ResolutionAction;
  /** 处理动作对应的新车牌/新吨数 */
  resolvedPlate?: string;
  resolvedTons?: number;
  note?: string;
}

export interface SyncLogEntry {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface SyncInput {
  plan: DeliveryPlan;
  vehicles: Vehicle[];
  batches: LoadingBatch[];
  conflicts: ConflictRecord[];
  /** 已处理过的回执集合（幂等台账） */
  processedReceipts: string[];
  now?: () => string;
  idGen?: () => string;
}

export interface SyncResult {
  plan: DeliveryPlan;
  batches: LoadingBatch[];
  conflicts: ConflictRecord[];
  processedReceipts: string[];
  mergedBatchIds: string[];
  logs: SyncLogEntry[];
}
