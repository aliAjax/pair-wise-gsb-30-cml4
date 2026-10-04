<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElSwitch, ElTag, ElButton } from "element-plus";
import { useDeliveryStore } from "../store";

const store = useDeliveryStore();
const { online, localPlan, serverPlan, lastSyncAt, stagedCount, openConflictCount, departedCount } =
  storeToRefs(store);

const onlineType = computed(() => (online.value ? "success" : "danger"));
</script>

<template>
  <header class="topbar panel-block">
    <div>
      <p class="eyebrow">石油行业 · 夜间断网装车与恢复合并</p>
      <h1>油品配送离线装车调度</h1>
      <p class="subtitle">
        离线按车次暂存装车批次，恢复后按「计划版本 + 车牌」与最新计划合并；
        同一回执只处理一次；改派、超容量、在途冲突一律进冲突台账，不覆盖在途计划，处理后按最新计划重算。
      </p>
    </div>
    <div class="net-box">
      <div class="net-line">
        <span class="net-label">网络状态</span>
        <ElSwitch
          :model-value="online"
          inline-prompt
          active-text="在线"
          inactive-text="断网"
          @update:model-value="(v: boolean) => store.setOnline(v)"
        />
        <ElTag :type="onlineType" effect="dark">{{ online ? "在线（服务器）" : "离线（本地暂存）" }}</ElTag>
      </div>
      <div class="version-line">
        <ElTag type="info">本地缓存计划 v{{ localPlan.version }}</ElTag>
        <span class="arrow">恢复合并 →</span>
        <ElTag type="warning">服务器最新计划 v{{ serverPlan.version }}</ElTag>
      </div>
      <p class="sync-time">最近同步：{{ lastSyncAt ? new Date(lastSyncAt).toLocaleString("zh-CN") : "尚未同步" }}</p>
      <div class="quick-metrics">
        <span class="chip">暂存 <b>{{ stagedCount }}</b></span>
        <span class="chip danger">未处理冲突 <b>{{ openConflictCount }}</b></span>
        <span class="chip ok">已发车 <b>{{ departedCount }}</b></span>
        <ElButton size="small" plain @click="store.resetDemo">重置演示数据</ElButton>
      </div>
    </div>
  </header>
</template>
