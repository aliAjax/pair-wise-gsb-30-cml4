<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  ElTable,
  ElTableColumn,
  ElTag,
  ElButton,
  ElSelect,
  ElOption,
  ElInputNumber,
  ElInput,
  ElMessage,
  ElEmpty,
} from "element-plus";
import { useDeliveryStore } from "../store";
import { CONFLICT_LABEL, REASON_TEXT } from "../lib/sync";
import type { ConflictReason, ConflictRecord } from "../types";

const store = useDeliveryStore();
const { conflicts, serverPlan, vehicles, batches } = storeToRefs(store);

// 每个未处理冲突各自维护一张处理表单
const actionByConflict = ref<Record<string, "reassign" | "reduce" | "void">>({});
const plateByConflict = ref<Record<string, string>>({});
const tonsByConflict = ref<Record<string, number>>({});
const noteByConflict = ref<Record<string, string>>({});

const openConflicts = computed(() => conflicts.value.filter((c) => c.status === "open"));
const resolvedConflicts = computed(() => conflicts.value.filter((c) => c.status === "resolved"));

function initForms() {
  for (const conflict of openConflicts.value) {
    if (!actionByConflict.value[conflict.id]) {
      // 默认建议动作：在途/车次缺失只能作废；改派建议跟随最新车牌；超容量建议减量
      if (conflict.reasons.includes("in_transit") || conflict.reasons.includes("trip_missing")) {
        actionByConflict.value[conflict.id] = "void";
      } else if (conflict.reasons.includes("reassigned")) {
        actionByConflict.value[conflict.id] = "reassign";
        plateByConflict.value[conflict.id] = conflict.currentPlate ?? "";
      } else {
        actionByConflict.value[conflict.id] = "reduce";
        tonsByConflict.value[conflict.id] = conflict.capacityTons ?? conflict.batchTons;
      }
    }
  }
}
initForms();

function reasonTags(reasons: ConflictReason[]) {
  return reasons.map((r) => CONFLICT_LABEL[r]).join("、");
}

function latestTrip(conflict: ConflictRecord) {
  return serverPlan.value.trips.find((t) => t.tripNo === conflict.tripNo);
}

function apply(conflict: ConflictRecord) {
  const action = actionByConflict.value[conflict.id];
  if (!action) {
    ElMessage.warning("请选择处理动作");
    return;
  }
  if (action === "reassign" && !plateByConflict.value[conflict.id]) {
    ElMessage.warning("请选择要跟随/改派的车牌");
    return;
  }
  if (action === "reduce") {
    const tons = tonsByConflict.value[conflict.id];
    const targetPlate = latestTrip(conflict)?.plate ?? conflict.requestedPlate;
    const cap = vehicles.value.find((v) => v.plate === targetPlate)?.capacityTons;
    if (typeof tons !== "number" || tons <= 0) {
      ElMessage.warning("请填写减量后的吨数");
      return;
    }
    if (cap !== undefined && tons > cap) {
      ElMessage.warning(`${targetPlate} 容量 ${cap}t，${tons}t 仍超容量，重算会继续留在台账`);
    }
  }
  store.handleConflict(conflict.id, action, {
    plate: plateByConflict.value[conflict.id],
    tons: tonsByConflict.value[conflict.id],
    note: noteByConflict.value[conflict.id],
  });
  noteByConflict.value[conflict.id] = "";
  initForms();
  ElMessage.success("已按最新计划重算");
}

function batchOf(conflict: ConflictRecord) {
  return batches.value.find((b) => b.id === conflict.batchId);
}
</script>

<template>
  <section class="panel-block">
    <div class="panel-title">
      <h2>冲突台账</h2>
      <div class="legend">
        <ElTag type="danger" size="small">待处理 {{ openConflicts.length }}</ElTag>
        <ElTag type="success" size="small">已处理 {{ resolvedConflicts.length }}</ElTag>
      </div>
    </div>
    <p class="hint">
      规则：本地批次与最新计划冲突时原样保留在此台账——不覆盖在途计划、不能确认发车；
      处理动作提交后按服务器最新计划重新评估，仍冲突会继续留在台账。
    </p>

    <ElEmpty v-if="conflicts.length === 0" description="暂无冲突，离线批次将全部按版本与车牌合并" />

    <div v-for="conflict in openConflicts" :key="conflict.id" class="conflict-card">
      <div class="conflict-head">
        <div>
          <strong>车次 {{ conflict.tripNo }}</strong>
          <ElTag type="danger" size="small" style="margin-left: 8px">
            {{ reasonTags(conflict.reasons) }}
          </ElTag>
        </div>
        <span class="muted-small">回执 {{ conflict.receipt }} · {{ new Date(conflict.createdAt).toLocaleString("zh-CN") }}</span>
      </div>
      <div class="conflict-grid">
        <div>
          <span class="field-label">本地批次</span>
          {{ conflict.requestedPlate }} / {{ conflict.batchTons }}t
        </div>
        <div>
          <span class="field-label">最新计划车牌</span>
          {{ conflict.currentPlate ?? "车次已不存在" }}
        </div>
        <div>
          <span class="field-label">本地车辆容量</span>
          {{ conflict.capacityTons ?? "无此车牌" }}
        </div>
        <div v-if="latestTrip(conflict)">
          <span class="field-label">最新车次状态</span>
          {{ latestTrip(conflict)?.status === "departed" ? "运输中（在途不可覆盖）" : "待发车" }}
        </div>
      </div>

      <div class="resolve-row">
        <ElSelect
          v-model="actionByConflict[conflict.id]"
          size="small"
          style="width: 160px"
          placeholder="处理动作"
        >
          <ElOption label="跟随最新车牌改派" value="reassign" :disabled="conflict.reasons.includes('in_transit') || conflict.reasons.includes('trip_missing')" />
          <ElOption label="减量到容量内" value="reduce" :disabled="conflict.reasons.includes('in_transit') || conflict.reasons.includes('trip_missing')" />
          <ElOption label="作废本地批次" value="void" />
        </ElSelect>

        <ElSelect
          v-if="actionByConflict[conflict.id] === 'reassign'"
          v-model="plateByConflict[conflict.id]"
          size="small"
          style="width: 200px"
          placeholder="选择车牌"
        >
          <ElOption v-for="v in vehicles" :key="v.plate" :label="`${v.plate}（${v.capacityTons}t）`" :value="v.plate" />
        </ElSelect>

        <template v-if="actionByConflict[conflict.id] === 'reduce'">
          <ElInputNumber
            v-model="tonsByConflict[conflict.id]"
            :min="1"
            :max="60"
            size="small"
            style="width: 130px"
          />
          <span class="muted-small">吨（不能超过目标车容量）</span>
        </template>

        <ElInput
          v-model="noteByConflict[conflict.id]"
          size="small"
          style="width: 220px"
          placeholder="处理说明（可选）"
        />
        <ElButton type="primary" size="small" @click="apply(conflict)">处理并重算</ElButton>
      </div>
    </div>

    <ElTable v-if="resolvedConflicts.length > 0" :data="resolvedConflicts" size="small" border style="margin-top: 8px">
      <ElTableColumn prop="tripNo" label="车次" width="80" />
      <ElTableColumn prop="receipt" label="回执" min-width="150" />
      <ElTableColumn label="处理动作" width="140">
        <template #default="{ row }">
          {{ row.resolution ? REASON_TEXT[row.resolution as keyof typeof REASON_TEXT] : "—" }}
          <span v-if="row.resolvedPlate"> → {{ row.resolvedPlate }}</span>
          <span v-if="row.resolvedTons !== undefined"> → {{ row.resolvedTons }}t</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="批次状态" width="110">
        <template #default="{ row }">
          <ElTag :type="batchOf(row)?.status === 'voided' ? 'info' : 'success'" size="small">
            {{ batchOf(row)?.status === "voided" ? "已作废" : "已合并待发车" }}
          </ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="note" label="说明" min-width="160" />
    </ElTable>
  </section>
</template>
