<script setup lang="ts">
import { storeToRefs } from "pinia";
import { ElTag } from "element-plus";
import { useDeliveryStore } from "../store";

const store = useDeliveryStore();
const { logs } = storeToRefs(store);

function levelType(level: string): "info" | "warning" | "danger" {
  if (level === "warn") return "warning";
  if (level === "error") return "danger";
  return "info";
}

function levelText(level: string): string {
  if (level === "warn") return "警告";
  if (level === "error") return "冲突";
  return "信息";
}
</script>

<template>
  <section class="panel-block">
    <div class="panel-title">
      <h2>同步与操作日志</h2>
    </div>
    <ul v-if="logs.length > 0" class="log-list">
      <li v-for="log in logs" :key="log.id" class="log-item">
        <ElTag :type="levelType(log.level)" size="small">{{ levelText(log.level) }}</ElTag>
        <span class="log-time">{{ new Date(log.at).toLocaleString("zh-CN") }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </li>
    </ul>
    <p v-else class="hint">暂无日志</p>
  </section>
</template>
