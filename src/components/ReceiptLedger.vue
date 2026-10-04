<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElTable, ElTableColumn, ElTag, ElEmpty } from "element-plus";
import { useDeliveryStore } from "../store";

const store = useDeliveryStore();
const { processedReceipts, batches } = storeToRefs(store);

interface ReceiptRow {
  receipt: string;
  tripNos: string;
  occurrences: number;
  firstBatchId: string;
}

const rows = computed<ReceiptRow[]>(() => {
  const map = new Map<string, ReceiptRow>();
  for (const batch of batches.value) {
    const existing = map.get(batch.receipt);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.tripNos.includes(batch.tripNo)) existing.tripNos += `、${batch.tripNo}`;
    } else {
      map.set(batch.receipt, {
        receipt: batch.receipt,
        tripNos: batch.tripNo,
        occurrences: 1,
        firstBatchId: batch.id,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.occurrences - a.occurrences || a.receipt.localeCompare(b.receipt));
});

function statusOf(receipt: string): string {
  const first = batches.value.find((b) => b.receipt === receipt && b.status !== "duplicate");
  return first?.status ?? "duplicate";
}

function label(status: string): { text: string; type: "success" | "info" | "warning" | "danger" } {
  switch (status) {
    case "merged":
      return { text: "已合并", type: "success" };
    case "departed":
      return { text: "已发车", type: "warning" };
    case "conflict":
      return { text: "已登记（冲突）", type: "danger" };
    case "voided":
      return { text: "已登记（作废）", type: "info" };
    default:
      return { text: "重复跳过", type: "info" };
  }
}
</script>

<template>
  <section class="panel-block">
    <div class="panel-title">
      <h2>回执幂等台账</h2>
      <ElTag type="success" size="small">已处理回执 {{ processedReceipts.length }} 条</ElTag>
    </div>
    <p class="hint">
      同一装车回执全局只处理一次：即使网络恢复后旧车次被重复发送，重复批次也会直接跳过，不会二次合并或二次发车。
    </p>
    <ElEmpty v-if="rows.length === 0" description="暂无回执记录" />
    <ElTable v-else :data="rows" size="small" border>
      <ElTableColumn prop="receipt" label="装车回执号" min-width="180" />
      <ElTableColumn prop="tripNos" label="关联车次" width="140" />
      <ElTableColumn label="发送批次数" width="110">
        <template #default="{ row }">
          {{ row.occurrences }} 次
          <ElTag v-if="row.occurrences > 1" type="danger" size="small" style="margin-left: 4px">存在重复发送</ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn label="幂等处理结果" width="150">
        <template #default="{ row }">
          <ElTag :type="label(statusOf(row.receipt)).type" size="small">
            {{ label(statusOf(row.receipt)).text }}
          </ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn label="是否计入已处理台账" width="160">
        <template #default="{ row }">
          <ElTag :type="processedReceipts.includes(row.receipt) ? 'success' : 'info'" size="small">
            {{ processedReceipts.includes(row.receipt) ? "是，再次发送即跳过" : "否（尚未同步）" }}
          </ElTag>
        </template>
      </ElTableColumn>
    </ElTable>
  </section>
</template>
