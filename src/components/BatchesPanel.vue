<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  ElButton,
  ElSelect,
  ElOption,
  ElInputNumber,
  ElTable,
  ElTableColumn,
  ElTag,
  ElMessage,
} from "element-plus";
import { useDeliveryStore } from "../store";
import { batchStatusLabel } from "../lib/sync";

const store = useDeliveryStore();
const { online, localPlan, vehicles, batches, serverPlan } = storeToRefs(store);

const selectedTrip = ref(localPlan.value.trips[0]?.tripNo ?? "");
const formTons = ref(18);

const selectedPlate = computed(() => {
  return localPlan.value.trips.find((t) => t.tripNo === selectedTrip.value)?.plate ?? "";
});

function capacityOf(plate: string): number | undefined {
  return vehicles.value.find((v) => v.plate === plate)?.capacityTons;
}

function stage() {
  if (!selectedTrip.value || !selectedPlate.value) {
    ElMessage.warning("请先选择车次");
    return;
  }
  const result = store.stageBatch({
    tripNo: selectedTrip.value,
    plate: selectedPlate.value,
    tons: formTons.value,
  });
  if (result.ok) {
    ElMessage.success(`已按车次暂存，回执 ${result.receipt}`);
  } else {
    ElMessage.warning(result.message);
  }
}

function sync() {
  const result = store.syncNow();
  if (result.ok) {
    ElMessage.success(`同步完成，合并 ${result.merged} 个批次；其余见冲突台账与回执记录`);
  } else {
    ElMessage.warning(result.message);
  }
}

function depart(batchId: string) {
  const error = store.depart(batchId);
  if (error) {
    ElMessage.error(error);
  } else {
    ElMessage.success("已确认发车，计划进入在途");
  }
}

function tagType(status: string) {
  switch (status) {
    case "merged":
      return "success" as const;
    case "conflict":
      return "danger" as const;
    case "duplicate":
      return "info" as const;
    case "departed":
      return "warning" as const;
    case "voided":
      return "info" as const;
    default:
      return "info" as const;
  }
}

const orderedBatches = computed(() =>
  [...batches.value].sort((a, b) => b.loadedAt.localeCompare(a.loadedAt)),
);

function latestPlate(tripNo: string) {
  return serverPlan.value.trips.find((t) => t.tripNo === tripNo)?.plate ?? "—（车次已取消）";
}
</script>

<template>
  <section class="panel-block">
    <div class="panel-title">
      <h2>离线装车批次（按车次暂存 → 恢复合并）</h2>
      <ElButton type="primary" :disabled="!online" @click="sync">立即同步合并</ElButton>
    </div>

    <div v-if="!online" class="stage-form">
      <div class="form-item">
        <label>车次（本地计划 v{{ localPlan.version }}）</label>
        <ElSelect v-model="selectedTrip" style="width: 260px">
          <ElOption
            v-for="t in localPlan.trips.filter((x) => x.status === 'planned')"
            :key="t.tripNo"
            :label="`${t.tripNo} · ${t.station} · ${t.fuel}`"
            :value="t.tripNo"
          />
        </ElSelect>
      </div>
      <div class="form-item">
        <label>车牌（取自本地配送单）</label>
        <ElInputNumber :model-value="undefined" disabled style="display: none" />
        <span class="plate-readonly">{{ selectedPlate }} · 容量 {{ capacityOf(selectedPlate) ?? "未知" }}t</span>
      </div>
      <div class="form-item">
        <label>实装吨数</label>
        <ElInputNumber v-model="formTons" :min="1" :max="60" />
      </div>
      <ElButton type="primary" @click="stage">离线暂存装车</ElButton>
    </div>
    <p v-else class="hint">
      当前在线：新批次将在同步时直接按最新计划合并。可在「配送计划」页签模拟另一名调度员改派，制造恢复后的冲突。
    </p>

    <ElTable :data="orderedBatches" size="small" border style="margin-top: 12px">
      <ElTableColumn prop="tripNo" label="车次" width="80" />
      <ElTableColumn label="本批车牌" width="110">
        <template #default="{ row }">
          {{ row.plate }}
          <div v-if="row.tons > (capacityOf(row.plate) ?? Infinity)" class="over-text">
            超容量 {{ row.tons - (capacityOf(row.plate) ?? 0) }}t
          </div>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="tons" label="吨数" width="70">
        <template #default="{ row }">{{ row.tons }}t</template>
      </ElTableColumn>
      <ElTableColumn label="依据版本" width="85">
        <template #default="{ row }">v{{ row.baseVersion }}</template>
      </ElTableColumn>
      <ElTableColumn label="最新计划车牌" width="160">
        <template #default="{ row }">
          <span :class="{ mismatch: latestPlate(row.tripNo) !== row.plate && latestPlate(row.tripNo) !== '—（车次已取消）' }">
            {{ latestPlate(row.tripNo) }}
          </span>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="receipt" label="装车回执" min-width="150" />
      <ElTableColumn label="发送" width="60">
        <template #default="{ row }">{{ row.timesSent }} 次</template>
      </ElTableColumn>
      <ElTableColumn label="状态" width="110">
        <template #default="{ row }">
          <ElTag :type="tagType(row.status)" size="small">{{ batchStatusLabel(row.status) }}</ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="message" label="同步说明" min-width="200" />
      <ElTableColumn label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <ElButton
            v-if="row.status === 'merged'"
            type="success"
            size="small"
            @click="depart(row.id)"
          >
            确认发车
          </ElButton>
          <span v-else-if="row.status === 'conflict'" class="muted-small">→ 冲突台账处理</span>
          <span v-else class="muted-small">—</span>
        </template>
      </ElTableColumn>
    </ElTable>
  </section>
</template>
