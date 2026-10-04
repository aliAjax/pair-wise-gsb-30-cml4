<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage, ElMessageBox } from "element-plus";
import { useDeliveryStore } from "./stores/delivery";
import type { ConflictReason, LoadingBatch } from "./types";

const store = useDeliveryStore();
const {
  plans,
  vehicles,
  batches,
  conflicts,
  logs,
  online,
  currentOperator,
  lastSyncAt,
  pendingBatches,
  openConflicts
} = storeToRefs(store);

const activeTab = ref("plans");

const conflictReasonText: Record<ConflictReason, string> = {
  计划版本过期: "计划版本过期（恢复后有新版本）",
  车辆已改派: "车辆已被另一名调度员改派",
  吨数超容量: "实装吨数超过车辆容量",
  计划已在途: "计划已在途，禁止覆盖与重复发车",
  计划不存在: "车次计划已被删除",
  车辆不存在: "批次车牌已不在车队"
};

const batchStatusType: Record<LoadingBatch["status"], "info" | "success" | "warning" | "danger"> = {
  待同步: "warning",
  已合并: "success",
  重复跳过: "info",
  冲突挂起: "danger"
};

// ---------- 离线装车录入 ----------

const batchForm = reactive({
  planCode: "",
  receiptId: "",
  plate: "",
  driver: "",
  tons: 0 as number
});

function fillDriverByPlate(plate: string) {
  const v = vehicles.value.find((item) => item.plate === plate);
  if (v) batchForm.driver = v.driver;
}

function submitBatch() {
  if (!batchForm.planCode || !batchForm.plate || !batchForm.tons) {
    ElMessage.warning("请选择车次、车牌并填写吨数");
    return;
  }
  store.addOfflineBatch({
    planCode: batchForm.planCode,
    plate: batchForm.plate,
    tons: batchForm.tons,
    driver: batchForm.driver,
    receiptId: batchForm.receiptId || undefined
  });
  ElMessage.success("司机离线装车，已按车次暂存到本地批次");
  batchForm.receiptId = "";
  batchForm.tons = 0;
}

// ---------- 联网/断网 ----------

async function toggleConnection() {
  if (!online.value) {
    const r = store.setOnline(true);
    ElMessage.success(`网络恢复，同步完成：合并 ${r.merged} 车，重复回执跳过 ${r.duplicated} 条，冲突挂起 ${r.conflicted} 条`);
    if (r.conflicted > 0) activeTab.value = "conflicts";
  } else {
    store.setOnline(false);
    ElMessage.info("已切换为夜间断网状态，司机装车将按车次暂存本地");
  }
}

function manualSync() {
  const r = store.syncPendingBatches();
  ElMessage.success(`同步完成：合并 ${r.merged}，跳过重复 ${r.duplicated}，冲突 ${r.conflicted}`);
  if (r.conflicted > 0) activeTab.value = "conflicts";
}

// ---------- 计划改派（模拟另一名调度员也可操作） ----------

async function editPlan(row: (typeof plans.value)[number]) {
  try {
    const { value } = await ElMessageBox.prompt(
      `车次 ${row.code}（当前 v${row.version}，车牌 ${row.plate || "未派车"}，${row.tons} 吨）。改派车牌或吨数会使计划版本 +1。`,
      "改派 / 调整吨数",
      {
        confirmButtonText: "保存并升版本",
        cancelButtonText: "取消",
        inputValue: row.tons,
        inputPattern: /^\d+(\.\d+)?$/,
        inputErrorMessage: "请输入数字吨数"
      }
    );
    store.updatePlan({ id: row.id, tons: Number(value) });
    ElMessage.success(`${row.code} 已更新到 v${row.version + 1}`);
  } catch {
    /* 取消 */
  }
}

function remoteReassign() {
  store.simulateRemoteReassign();
  ElMessage.warning("模拟：断网期间调度员李强在他端把 PC-1004 改派到 京C·3003（v2）");
}

// ---------- 冲突处理 ----------

const fixing = ref<Record<string, { plate: string; tons: number }>>({});

function startFix(receiptId: string, plate: string, tons: number) {
  fixing.value[receiptId] = { plate, tons };
}

function saveFix(receiptId: string) {
  const patch = fixing.value[receiptId];
  if (patch) store.fixBatch(receiptId, patch);
  delete fixing.value[receiptId];
  ElMessage.success("本地批次已修正，点击「按最新计划重算」再比对");
}

function recompute(id: string) {
  store.recomputeConflict(id);
}

async function discard(id: string) {
  try {
    await ElMessageBox.confirm("确认作废该冲突回执？作废后该批次不再并入在途计划，台账保留记录。", "作废冲突", {
      type: "warning"
    });
    store.discardConflict(id);
    ElMessage.info("冲突已作废");
  } catch {
    /* 取消 */
  }
}

async function changeCapacity(plate: string) {
  const v = vehicles.value.find((item) => item.plate === plate)!;
  try {
    const { value } = await ElMessageBox.prompt(
      `调整 ${plate} 的核定载量（当前 ${v.capacity} 吨）。调整后请到冲突台账按最新计划重算。`,
      "车辆容量变更",
      {
        inputValue: String(v.capacity),
        inputPattern: /^\d+(\.\d+)?$/,
        inputErrorMessage: "请输入数字吨数"
      }
    );
    store.updateVehicleCapacity(plate, Number(value));
    ElMessage.success(`${plate} 容量已调整为 ${value} 吨`);
  } catch {
    /* 取消 */
  }
}

function resetAll() {
  store.resetDemo();
  ElMessage.success("演示数据已重置为夜间断网初始状态");
}

const planById = computed(() => new Map(plans.value.map((p) => [p.code, p])));
const vehicleByPlate = computed(() => new Map(vehicles.value.map((v) => [v.plate, v])));

function fmtTime(iso: string) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-";
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">油品配送 · 离线装车 / 恢复合并 / 冲突台账</p>
          <h1>夜间断网配送调度闭环</h1>
          <p class="subtitle">
            司机离线按车次暂存装车批次；网络恢复后按<strong>计划版本 + 车牌</strong>合并，
            <strong>同一回执只处理一次</strong>；车辆已改派或吨数超容量时批次进入冲突台账，
            不覆盖在途计划、不确认发车，处理完再按最新计划重算。
          </p>
        </div>
        <div class="conn-box">
          <div class="conn-state" :class="online ? 'on' : 'off'">
            <span class="dot" />
            {{ online ? "网络在线" : "夜间断网中" }}
          </div>
          <button :class="online ? 'secondary' : ''" @click="toggleConnection">
            {{ online ? "模拟断网" : "模拟网络恢复并同步" }}
          </button>
          <p class="operator">当前调度员：{{ currentOperator }}</p>
          <p class="operator">上次同步：{{ fmtTime(lastSyncAt) }}</p>
          <button class="link-btn" @click="resetAll">重置演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>待同步本地批次</span>
          <strong>{{ pendingBatches.length }}</strong>
        </article>
        <article class="metric">
          <span>未决冲突</span>
          <strong :class="{ alert: openConflicts.length > 0 }">{{ openConflicts.length }}</strong>
        </article>
        <article class="metric">
          <span>在途 / 已到站车次</span>
          <strong>{{ store.inTransitCount }}</strong>
        </article>
        <article class="metric">
          <span>已处理回执（幂等表）</span>
          <strong>{{ store.processedReceipts.size }}</strong>
        </article>
      </section>

      <el-tabs v-model="activeTab" class="tabs">
        <!-- ============ 配送计划 ============ -->
        <el-tab-pane name="plans">
          <template #label>
            <span>配送计划 <el-badge :value="plans.length" class="tab-badge" type="primary" /></span>
          </template>

          <div class="panel">
            <div class="toolbar">
              <h2>在途配送计划（含版本号）</h2>
              <div class="toolbar-actions">
                <button class="secondary" type="button" @click="remoteReassign">模拟他端调度员改派 PC-1004</button>
              </div>
            </div>
            <el-table :data="plans" stripe>
              <el-table-column prop="code" label="车次" width="100" />
              <el-table-column prop="station" label="油站" width="90" />
              <el-table-column prop="fuel" label="油品" width="110" />
              <el-table-column label="吨数" width="80">
                <template #default="{ row }">{{ row.tons }} 吨</template>
              </el-table-column>
              <el-table-column label="车牌 / 容量" width="170">
                <template #default="{ row }">
                  <div>{{ row.plate || "未派车" }}</div>
                  <div v-if="vehicleByPlate.get(row.plate)" class="sub">
                    容量 {{ vehicleByPlate.get(row.plate).capacity }} 吨
                    <span v-if="row.tons > vehicleByPlate.get(row.plate).capacity" class="over">（当前计划已超容量！）</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.status === '待发车' ? 'warning' : 'success'">{{ row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="版本 / 修改人" width="170">
                <template #default="{ row }">
                  <div>v{{ row.version }}</div>
                  <div class="sub">{{ row.updatedBy }}</div>
                </template>
              </el-table-column>
              <el-table-column prop="notes" label="备注" min-width="200" show-overflow-tooltip />
              <el-table-column label="操作" width="120" fixed="right">
                <template #default="{ row }">
                  <el-button size="small" @click="editPlan(row)">改派/改吨</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <!-- ============ 离线装车批次 ============ -->
        <el-tab-pane name="batches">
          <template #label>
            <span>离线装车批次
              <el-badge v-if="pendingBatches.length" :value="pendingBatches.length" class="tab-badge" type="warning" />
            </span>
          </template>

          <div class="workspace">
            <form class="panel batch-form" @submit.prevent="submitBatch">
              <h2>司机离线装车（按车次暂存）</h2>
              <p class="form-hint" :class="online ? 'hint-on' : 'hint-off'">
                {{ online ? "当前在线：批次仍会先暂存，恢复/手动同步时合并" : "当前断网：批次只写入本地，不触碰在途计划" }}
              </p>
              <label>
                计划车次
                <select v-model="batchForm.planCode" required>
                  <option value="" disabled>选择车次</option>
                  <option v-for="p in plans" :key="p.id" :value="p.code">
                    {{ p.code }} · {{ p.station }} · {{ p.fuel }}（v{{ p.version }}）
                  </option>
                </select>
              </label>
              <label>
                装车车牌
                <select v-model="batchForm.plate" required @change="fillDriverByPlate(batchForm.plate)">
                  <option value="" disabled>选择车牌</option>
                  <option v-for="v in vehicles" :key="v.plate" :value="v.plate">
                    {{ v.plate }}（容量 {{ v.capacity }} 吨 / {{ v.driver }}）
                  </option>
                </select>
              </label>
              <label>
                装车吨数
                <input v-model.number="batchForm.tons" type="number" min="0" step="0.5" required />
              </label>
              <label>
                司机
                <input v-model="batchForm.driver" placeholder="默认带出车辆登记司机" required />
              </label>
              <label>
                装车回执号（留空自动生成；填相同号可验证幂等）
                <input v-model="batchForm.receiptId" placeholder="如 HK-5001" />
              </label>
              <button type="submit">暂存离线批次</button>
            </form>

            <section class="panel">
              <div class="toolbar">
                <h2>本地装车批次（按车次）</h2>
                <button class="secondary" type="button" :disabled="!pendingBatches.length" @click="manualSync">
                  立即按版本+车牌同步
                </button>
              </div>
              <el-table :data="batches" stripe>
                <el-table-column prop="receiptId" label="回执号" width="110" />
                <el-table-column prop="planCode" label="车次" width="95" />
                <el-table-column label="快照版本" width="90">
                  <template #default="{ row }">
                    v{{ row.snapshotVersion }}
                    <span v-if="planById.get(row.planCode) && planById.get(row.planCode).version !== row.snapshotVersion" class="over">
                      → 线上 v{{ planById.get(row.planCode).version }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="plate" label="车牌" width="115" />
                <el-table-column label="吨数" width="75">
                  <template #default="{ row }">{{ row.tons }} 吨</template>
                </el-table-column>
                <el-table-column prop="driver" label="司机" width="90" />
                <el-table-column label="装车时间" width="170">
                  <template #default="{ row }">{{ fmtTime(row.loadedAt) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="100">
                  <template #default="{ row }">
                    <el-tag :type="batchStatusType[row.status as LoadingBatch['status']]">{{ row.status }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="resultNote" label="处理说明" min-width="220" show-overflow-tooltip />
              </el-table>
            </section>
          </div>
        </el-tab-pane>

        <!-- ============ 冲突台账 ============ -->
        <el-tab-pane name="conflicts">
          <template #label>
            <span>冲突台账
              <el-badge v-if="openConflicts.length" :value="openConflicts.length" class="tab-badge" type="danger" />
            </span>
          </template>

          <section class="panel">
            <h2>冲突台账（批次保留留痕，不覆盖在途计划、不确认发车）</h2>
            <div v-if="conflicts.length === 0" class="empty">暂无冲突。先「模拟断网 → 装车 → 他端改派/超容量 → 恢复同步」即可产生冲突。</div>
            <el-table v-else :data="[...conflicts].reverse()" stripe>
              <el-table-column prop="receiptId" label="回执号" width="105" />
              <el-table-column prop="planCode" label="车次" width="90" />
              <el-table-column prop="plate" label="批次车牌" width="110" />
              <el-table-column label="批次/最新吨数" width="120">
                <template #default="{ row }">
                  {{ row.batchTons }} 吨
                  <div v-if="planById.get(row.planCode)" class="sub">线上 {{ planById.get(row.planCode).tons }} 吨</div>
                </template>
              </el-table-column>
              <el-table-column label="冲突原因" min-width="240">
                <template #default="{ row }">
                  <el-tag
                    v-for="reason in row.reasons"
                    :key="reason"
                    type="danger"
                    size="small"
                    class="reason-tag"
                  >
                    {{ conflictReasonText[reason as ConflictReason] }}
                  </el-tag>
                  <p v-if="row.status === '已解决'" class="ok-text">{{ row.resolution }}</p>
                  <p v-else-if="row.status === '已作废'" class="muted-text">{{ row.resolution }}</p>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.status === '未决' ? 'danger' : row.status === '已解决' ? 'success' : 'info'">
                    {{ row.status }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="处理（改批次，勿动在途计划）" width="360" fixed="right">
                <template #default="{ row }">
                  <template v-if="row.status === '未决'">
                    <div v-if="!fixing[row.receiptId]" class="conflict-actions">
                      <el-button size="small" type="primary" @click="startFix(row.receiptId, row.plate, row.batchTons)">
                        换车/改吨
                      </el-button>
                      <el-button size="small" type="success" @click="recompute(row.id)">按最新计划重算</el-button>
                      <el-button size="small" @click="changeCapacity(row.plate)">扩容车辆</el-button>
                      <el-button size="small" type="danger" plain @click="discard(row.id)">作废</el-button>
                    </div>
                    <div v-else class="fix-row">
                      <select v-model="fixing[row.receiptId].plate">
                        <option v-for="v in vehicles" :key="v.plate" :value="v.plate">{{ v.plate }}</option>
                      </select>
                      <input v-model.number="fixing[row.receiptId].tons" type="number" step="0.5" class="fix-tons" />
                      <el-button size="small" @click="saveFix(row.receiptId)">保存</el-button>
                      <el-button size="small" @click="recompute(row.id)">重算</el-button>
                    </div>
                  </template>
                  <span v-else class="sub">{{ fmtTime(row.resolvedAt) }}</span>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <!-- ============ 车队与日志 ============ -->
        <el-tab-pane name="fleet">
          <div class="workspace fleet-workspace">
            <section class="panel">
              <h2>车辆容量</h2>
              <el-table :data="vehicles" stripe>
                <el-table-column prop="plate" label="车牌" width="120" />
                <el-table-column prop="driver" label="司机" width="100" />
                <el-table-column label="核定载量" width="110">
                  <template #default="{ row }">{{ row.capacity }} 吨</template>
                </el-table-column>
                <el-table-column prop="remark" label="车型备注" min-width="160" />
                <el-table-column label="操作" width="120">
                  <template #default="{ row }">
                    <el-button size="small" @click="changeCapacity(row.plate)">调整容量</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </section>

            <section class="panel">
              <h2>同步 / 处理日志</h2>
              <div v-if="logs.length === 0" class="empty">暂无日志，恢复网络同步后在此留痕。</div>
              <ul v-else class="log-list">
                <li v-for="log in logs" :key="log.id">
                  <span class="log-time">{{ fmtTime(log.at) }}</span>
                  <el-tag size="small" :type="log.result === '合并' ? 'success' : log.result === '冲突挂起' ? 'danger' : 'info'">
                    {{ log.result }}
                  </el-tag>
                  <span class="log-text">[{{ log.receiptId }}] {{ log.planCode }}：{{ log.detail }}</span>
                </li>
              </ul>
            </section>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </main>
</template>
