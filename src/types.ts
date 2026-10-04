// 油品配送 - 离线装车与同步领域模型

/** 配送计划状态 */
export type PlanStatus = "待发车" | "运输中" | "已到站";

/** 车辆 */
export interface Vehicle {
  /** 车牌，唯一主键 */
  plate: string;
  /** 最大载量（吨） */
  capacity: number;
  /** 当前司机 */
  driver: string;
  /** 备注，如车型 */
  remark?: string;
}

/**
 * 配送计划（在途计划）。
 * 每次被调度员改派/改吨/确认发车都会使 version +1，
 * 离线批次用 snapshotVersion 记录装车时所依据的版本。
 */
export interface DeliveryPlan {
  id: string;
  /** 计划车次编号，如 PC-1001 */
  code: string;
  station: string;
  fuel: string;
  /** 计划吨数（当前最新版本） */
  tons: number;
  arriveAt: string;
  status: PlanStatus;
  /** 当前指派车牌；空串表示尚未派车 */
  plate: string;
  /** 计划版本号，初始为 1 */
  version: number;
  /** 最近一次修改人（用于判断是否另一名调度员改派） */
  updatedBy: string;
  updatedAt: string;
  notes?: string;
}

/** 离线装车批次状态 */
export type BatchStatus =
  | "待同步" // 离线暂存，尚未处理
  | "已合并" // 恢复后与最新计划成功合并
  | "重复跳过" // 回执已处理过
  | "冲突挂起"; // 命中冲突，保留在冲突台账中

/**
 * 司机离线装车批次：按车次暂存的本地配送单。
 * receiptId 为装车回执编号，同步时同一回执只处理一次。
 */
export interface LoadingBatch {
  /** 车次暂存 ID（本地） */
  id: string;
  /** 装车回执号（幂等键） */
  receiptId: string;
  /** 关联的计划车次编号 */
  planCode: string;
  /** 装车时依据的计划版本 */
  snapshotVersion: number;
  /** 装车车牌（离线时以本地调度为准） */
  plate: string;
  /** 实际装车吨数 */
  tons: number;
  /** 装车司机 */
  driver: string;
  /** 装车时间（通常发生在断网夜间） */
  loadedAt: string;
  status: BatchStatus;
  /** 处理后写入的说明 */
  resultNote?: string;
  /** 调度员是否已在冲突台账中显式修正（换车/改吨）过该批次 */
  dispatcherAdjusted?: boolean;
}

/** 冲突原因 */
export type ConflictReason =
  | "计划版本过期" // 计划已被改动（版本号不一致）
  | "车辆已改派" // 车牌已被另一名调度员派给其他车
  | "吨数超容量" // 实际装车吨数 > 当前车辆容量
  | "计划已在途" // 计划已确认发车（运输中/已到站），禁止覆盖
  | "计划不存在" // 恢复后该车次计划已被删除
  | "车辆不存在"; // 批次引用的车牌在车队中已不存在

/** 冲突台账记录 */
export interface ConflictEntry {
  id: string;
  /** 关联回执号，同一回执一条未决记录 */
  receiptId: string;
  planCode: string;
  plate: string;
  batchTons: number;
  snapshotVersion: number;
  /** 当前检测到的全部冲突原因 */
  reasons: ConflictReason[];
  status: "未决" | "已解决" | "已作废";
  /** 调度员处理动作记录 */
  resolution?: string;
  resolvedAt?: string;
  detectedAt: string;
}

/** 同步日志条目 */
export interface SyncLog {
  id: string;
  at: string;
  receiptId: string;
  planCode: string;
  result: "合并" | "重复跳过" | "冲突挂起";
  detail: string;
}
