<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElTable, ElTableColumn, ElTag, ElSelect, ElOption, ElInputNumber, ElButton, ElRadioGroup, ElRadio, ElMessage } from "element-plus";
import { useDeliveryStore } from "../store";
import type { TripStatus } from "../types";

const store = useDeliveryStore();
const { online, localPlan, serverPlan, vehicles } = storeToRefs(store);

const view = ref<"local" | "server">("local");
watch(online, (value) => {
  view.value = value ? "server" : "local";
}, { immediate: true });

const trips = computed(() => (view.value === "local" ? localPlan.value.trips : serverPlan.value.trips));

function statusTag(status: TripStatus) {
  switch (status) {
    case "planned":
      return { type: "info" as const, text: "待发车" };
    case "departed":
      return { type: "warning" as const, text: "运输中" };
    case "arrived":
      return { type: "success" as const, text: "已到站" };
    case "cancelled":
      return { type: "danger" as const, text: "已取消" };
  }
}

function capacityOf(plate: string): number | undefined {
  return vehicles.value.find((v) => v.plate === plate)?.capacityTons;
}

function onPlateChange(tripNo: string, plate: string) {
  store.editLocalTrip(tripNo, { plate });
}

function onTonsChange(tripNo: string, tons: number | undefined) {
  if (typeof tons === "number") store.editLocalTrip(tripNo, { tons });
}

function reassign(tripNo: string, plate: string) {
  const result = store.simulateReassign(tripNo, plate);
  if (result.ok) {
    ElMessage.success(`已模拟另一名调度员改派为 ${plate}，计划版本升为 v${serverPlan.value.version}`);
  } else {
    ElMessage.warning(result.message);
  }
}
</script>

<template>
  <section class="panel-block">
    <div class="panel-title">
      <h2>
        {{ view === "local" ? `本地配送计划 v${localPlan.version}（离线缓存）` : `服务器最新配送计划 v${serverPlan.version}` }}
      </h2>
      <ElRadioGroup v-model="view" size="small">
        <ElRadio value="local">本地版本</ElRadio>
        <ElRadio value="server">服务器版本</ElRadio>
      </ElRadioGroup>
    </div>

    <p v-if="view === 'local' && !online" class="hint">
      断网中：可直接改本地配送单的车牌与吨数，改动仅留在本地 v{{ localPlan.version }}，不会覆盖在途计划。
    </p>
    <p v-else-if="view === 'server' && online" class="hint">
      在线：点「模拟他人改派」可让另一名调度员在服务器端把车辆改走，计划版本随即 +1，用于验证恢复合并闸门。
    </p>

    <ElTable :data="trips" size="small" border stripe empty-text="该版本无车次">
      <ElTableColumn prop="tripNo" label="车次号" width="90" />
      <ElTableColumn prop="station" label="油站" width="90" />
      <ElTableColumn prop="fuel" label="油品" width="110" />
      <ElTableColumn label="吨数" width="120">
        <template #default="{ row }">
          <ElInputNumber
            v-if="view === 'local' && !online && row.status === 'planned'"
            :model-value="row.tons"
            :min="1"
            :max="60"
            size="small"
            @update:model-value="(v: number | undefined) => onTonsChange(row.tripNo, v)"
          />
          <span v-else>{{ row.tons }} t</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="车牌 / 容量" width="230">
        <template #default="{ row }">
          <template v-if="view === 'local' && !online && row.status === 'planned'">
            <ElSelect
              :model-value="row.plate"
              size="small"
              style="width: 200px"
              @update:model-value="(v: string) => onPlateChange(row.tripNo, v)"
            >
              <ElOption v-for="v in vehicles" :key="v.plate" :label="`${v.plate}（${v.capacityTons}t）`" :value="v.plate" />
            </ElSelect>
          </template>
          <template v-else>
            <span :class="{ over: row.tons > (capacityOf(row.plate) ?? Infinity) }">{{ row.plate }}</span>
            <span class="cap">（容量 {{ capacityOf(row.plate) ?? "未知" }}t）</span>
          </template>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="arriveAt" label="计划到达" width="115" />
      <ElTableColumn label="状态" width="100">
        <template #default="{ row }">
          <ElTag :type="statusTag(row.status).type" size="small">{{ statusTag(row.status).text }}</ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn label="改派人 / 回执" min-width="180">
        <template #default="{ row }">
          <span v-if="row.updatedBy" class="muted">{{ row.updatedBy }}</span>
          <span v-else class="muted">—</span>
          <div v-if="row.departureReceipt" class="receipt">在途回执 {{ row.departureReceipt }}</div>
        </template>
      </ElTableColumn>
      <ElTableColumn v-if="view === 'server' && online" label="模拟操作" width="210">
        <template #default="{ row }">
          <ElSelect
            v-if="row.status === 'planned'"
            :model-value="row.plate"
            size="small"
            placeholder="选择改派车辆"
            style="width: 120px"
            @update:model-value="(v: string) => reassign(row.tripNo, v)"
          >
            <ElOption
              v-for="v in vehicles.filter((x) => x.plate !== row.plate)"
              :key="v.plate"
              :label="`${v.plate} ${v.capacityTons}t`"
              :value="v.plate"
            />
          </ElSelect>
          <span v-else class="muted">在途不可改派</span>
        </template>
      </ElTableColumn>
    </ElTable>
  </section>
</template>
